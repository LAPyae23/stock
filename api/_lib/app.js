import { Elysia, NotFound, ParseError } from "elysia";
import { cors } from "@elysia/cors";
import { node } from "@elysia/node";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { getDb, withTx, oid, defaultSettings } from "./db.js";
import { parseVoice } from "./voice.js";
import { log, beginRequest, endRequest, noteResponse, requestIdOf } from "./logger.js";

const origins = (process.env.WEB_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean);
// Product photos are sent as compressed data URLs; Vercel caps request bodies at 4.5 MB.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const isProd = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
const JWT_SECRET = process.env.JWT_SECRET || (isProd ? "" : "development-only-change-this-secret");
const sign = (user) => {
  if (!JWT_SECRET) throw httpError(500, "CONFIG_ERROR", "JWT_SECRET is not configured on the server.");
  return jwt.sign({ sub: String(user._id), role: user.role }, JWT_SECRET, { expiresIn: "7d" });
};

const CATEGORIES = ["Food & Beverage", "Household", "Personal Care", "Stationery", "Electronics", "Hardware", "Medical Supplies", "Packaging", "Agriculture", "Other"];
const REORDER_FLOW = { PENDING: ["CONFIRM_SHIPPING", "RECEIVED", "CANCELLED"], CONFIRM_SHIPPING: ["RECEIVED", "CANCELLED"] };

function httpError(status, error, message) {
  return Object.assign(new Error(message), { status, error });
}
const fail = (status, error, message) => { throw httpError(status, error, message); };
const jsonBody = (body) => (body && typeof body === "object" && !Array.isArray(body) ? body : {});
// The @elysia/node beta adapter currently drops status codes set with Elysia's status() helper,
// so return a real Response for non-200 results. This also works unchanged on Bun and Vercel.
const json = (code, body) => new Response(body === undefined ? null : JSON.stringify(body), {
  status: code,
  ...(body === undefined ? {} : { headers: { "content-type": "application/json; charset=utf-8" } })
});

// ---------- serialisation ----------
function out(doc) {
  if (!doc) return doc;
  const { _id, passwordHash, ...rest } = doc;
  const o = { id: String(_id) };
  for (const [k, v] of Object.entries(rest)) o[k] = v instanceof ObjectId ? String(v) : v;
  return o;
}
function stockStatus(p) {
  if (p.quantity <= 0) return "OUT_OF_STOCK";
  if (p.quantity <= p.lowStockThreshold) return "LOW_STOCK";
  return "IN_STOCK";
}
const productOut = (p) => (p ? { ...out(p), status: stockStatus(p) } : p);

// ---------- restock forecast ----------
// Average daily ship-out over the last 30 days predicts when each item runs out, and how much
// to order so stock covers supplier lead time (7 days) plus two more weeks.
const USAGE_WINDOW_DAYS = 30;
const COVER_DAYS = 21;
const DAY_MS = 86_400_000;

async function usageByProduct(db, warehouseId) {
  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * DAY_MS);
  const rows = await db.collection("movements").aggregate([
    { $match: { warehouseId, type: "OUT", createdAt: { $gte: since } } },
    { $group: { _id: "$productId", shipped: { $sum: { $abs: "$delta" } } } }
  ]).toArray();
  return new Map(rows.map((r) => [String(r._id), r.shipped]));
}
function forecast(p, usage) {
  const shipped = usage.get(String(p._id ?? p.id)) || 0;
  if (!shipped) return { dailyUsage: 0, daysLeft: null, suggestedOrder: 0 };
  // Newer products are averaged over their own age, but never less than a week to avoid spikes.
  const ageDays = (Date.now() - new Date(p.createdAt || Date.now()).getTime()) / DAY_MS;
  const rate = shipped / Math.min(USAGE_WINDOW_DAYS, Math.max(7, ageDays));
  return {
    dailyUsage: Math.round(rate * 10) / 10,
    daysLeft: p.quantity <= 0 ? 0 : Math.floor(p.quantity / rate),
    suggestedOrder: Math.max(0, Math.ceil(rate * COVER_DAYS) - p.quantity)
  };
}
const warehouseOut = (w) => (w ? { ...out(w), settings: { ...defaultSettings, ...(w.settings || {}) } } : w);

// ---------- input cleaning ----------
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);
function cleanInt(value, min = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
const today = () => new Date().toISOString().slice(0, 10);
function addDays(days, from) {
  const d = from ? new Date(`${from}T00:00:00Z`) : new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function cleanPhotos(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => typeof p === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(p) && p.length < 1_500_000).slice(0, 4);
}
function productFields(b, old = {}) {
  const pick = (key, max) => (b[key] !== undefined ? str(b[key], max) : old[key] ?? "");
  const threshold = b.lowStockThreshold !== undefined ? cleanInt(b.lowStockThreshold) : old.lowStockThreshold ?? 5;
  if (threshold === null) fail(400, "VALIDATION_ERROR", "Low-stock threshold must be a non-negative whole number.");
  // Shelf life lets undated goods (bread, vegetables, local products) get an expiry date automatically on stock-in.
  const shelfLife = b.shelfLifeDays !== undefined && b.shelfLifeDays !== "" ? cleanInt(b.shelfLifeDays) : old.shelfLifeDays ?? 0;
  if (shelfLife === null || shelfLife > 3650) fail(400, "VALIDATION_ERROR", "Shelf life must be between 0 and 3650 days.");
  const fields = {
    name: pick("name", 160), description: pick("description", 2000), sku: pick("sku", 80), barcode: pick("barcode", 80),
    category: pick("category", 80) || "Other", unit: pick("unit", 40) || "pcs", supplier: pick("supplier", 160),
    supplierPhone: pick("supplierPhone", 60), supplierEmail: pick("supplierEmail", 160), fdaCode: pick("fdaCode", 80),
    remarks: pick("remarks", 1000), lowStockThreshold: threshold, shelfLifeDays: shelfLife,
    photos: b.photos !== undefined ? cleanPhotos(b.photos) : old.photos ?? []
  };
  if (!fields.name) fail(400, "VALIDATION_ERROR", "Product name is required.");
  if (!fields.sku) fields.sku = fields.barcode || `INV-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  return fields;
}

// ---------- authentication ----------
async function authenticate(request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET || "missing");
  } catch {
    fail(401, "AUTH_REQUIRED", "Please sign in again.");
  }
  const db = await getDb();
  const user = await db.collection("users").findOne({ _id: oid(payload.sub) });
  if (!user) fail(401, "AUTH_REQUIRED", "Please sign in again.");
  const warehouse = await db.collection("warehouses").findOne({ _id: user.warehouseId });
  if (!warehouse) fail(403, "WAREHOUSE_REQUIRED", "No active warehouse is linked to this account.");
  return { db, user, warehouse };
}
function requireOwner(user) {
  if (user.role !== "OWNER") fail(403, "OWNER_REQUIRED", "Only the owner can perform this action.");
}
async function findProduct(db, warehouseId, id, session) {
  const _id = oid(String(id || ""));
  if (!_id) fail(400, "VALIDATION_ERROR", "Choose a product.");
  const p = await db.collection("products").findOne({ _id, warehouseId, archived: false }, { session });
  if (!p) fail(404, "NOT_FOUND", "Product not found.");
  return p;
}

// ---------- stock core ----------
async function recordMovement(db, session, { warehouse, user, product, type, delta, beforeQty, afterQty, reason = "", reference = "", note = "", batchId = null }) {
  await db.collection("movements").insertOne({
    warehouseId: warehouse._id, productId: product._id, actorId: user._id, productName: product.name, sku: product.sku,
    actorName: user.name, type, delta, beforeQty, afterQty, reason: str(reason), reference: str(reference, 120),
    note: str(note, 1000), batchId, createdAt: new Date()
  }, { session });
}

async function stockIn(db, session, { warehouse, user, product, qty, type = "IN", reason, reference, note, expiryDate, batchNumber, stockInDate, remarks }) {
  const updated = await db.collection("products").findOneAndUpdate(
    { _id: product._id, warehouseId: warehouse._id, archived: false },
    { $inc: { quantity: qty }, $set: { updatedAt: new Date() } },
    { returnDocument: "after", session }
  );
  if (!updated) fail(404, "NOT_FOUND", "Product not found.");
  let batchId = null;
  const inDate = isoDate(stockInDate) || today();
  const expiry = isoDate(expiryDate) || (updated.shelfLifeDays > 0 ? addDays(updated.shelfLifeDays, inDate) : "");
  if (expiry || str(batchNumber)) {
    batchId = new ObjectId();
    await db.collection("batches").insertOne({
      _id: batchId, warehouseId: warehouse._id, productId: product._id, lotNumber: str(batchNumber, 80), expiryDate: expiry,
      stockInDate: inDate, quantity: qty, remarks: str(remarks, 1000), createdAt: new Date(),
      expirySource: isoDate(expiryDate) ? "entered" : expiry ? "shelfLife" : ""
    }, { session });
  }
  updated.receivedExpiry = expiry;
  await recordMovement(db, session, {
    warehouse, user, product: updated, type, delta: qty, beforeQty: updated.quantity - qty, afterQty: updated.quantity,
    reason: reason || (type === "OPENING" ? "Opening stock" : "Stock received"), reference,
    note: [str(note, 1000), str(remarks, 1000)].filter(Boolean).join(" · "), batchId
  });
  return updated;
}

async function consumeBatches(db, session, warehouseId, productId, qty) {
  // First-expiry-first-out, so expiry alerts follow the stock that is actually left.
  const batches = await db.collection("batches").find({ warehouseId, productId, quantity: { $gt: 0 } }, { session })
    .sort({ expiryDate: 1, createdAt: 1 }).toArray();
  batches.sort((a, b) => (a.expiryDate || "9999").localeCompare(b.expiryDate || "9999"));
  let left = qty;
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(left, b.quantity);
    await db.collection("batches").updateOne({ _id: b._id }, { $inc: { quantity: -take } }, { session });
    left -= take;
  }
}

// ---------- suppliers helpers ----------
// Suppliers are their own records; products keep a copy of the name/phone/email so older screens
// and order messages keep working, and that copy is refreshed whenever the supplier is edited.
const SUPPLIER_FIELDS = { name: 160, contactPerson: 120, phone: 60, email: 160, social: 200, website: 200, address: 500, note: 1000 };
function supplierFields(b, old = {}) {
  const f = {};
  for (const [k, max] of Object.entries(SUPPLIER_FIELDS)) f[k] = b[k] !== undefined ? str(b[k], max) : old[k] ?? "";
  if (!f.name) fail(400, "VALIDATION_ERROR", "Supplier name is required.");
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) fail(400, "VALIDATION_ERROR", "Enter a valid supplier email.");
  return f;
}
async function syncProductsToSupplier(db, s) {
  await db.collection("products").updateMany(
    { warehouseId: s.warehouseId, supplierId: s._id },
    { $set: { supplier: s.name, supplierPhone: s.phone, supplierEmail: s.email, updatedAt: new Date() } }
  );
}
/** Turns supplier names typed on products before suppliers existed into supplier records (runs once per name). */
async function adoptProductSuppliers(db, warehouseId) {
  const loose = await db.collection("products").find({ warehouseId, archived: false, supplier: { $gt: "" }, supplierId: { $exists: false } }, { projection: { supplier: 1, supplierPhone: 1, supplierEmail: 1 } }).toArray();
  for (const p of loose) {
    let s = await db.collection("suppliers").findOne({ warehouseId, name: p.supplier });
    if (!s) {
      s = { _id: new ObjectId(), warehouseId, ...supplierFields({ name: p.supplier, phone: p.supplierPhone, email: p.supplierEmail }), createdAt: new Date(), updatedAt: new Date() };
      try { await db.collection("suppliers").insertOne(s); } catch (e) { if (e?.code !== 11000) throw e; s = await db.collection("suppliers").findOne({ warehouseId, name: p.supplier }); }
    }
    await db.collection("products").updateOne({ _id: p._id }, { $set: { supplierId: s._id } });
  }
}
/** Copies the chosen supplier onto product fields; an empty id clears the link. */
async function applySupplier(db, warehouseId, fields, supplierId) {
  if (supplierId === undefined) return;
  if (!supplierId) { Object.assign(fields, { supplierId: null }); return; }
  const s = await db.collection("suppliers").findOne({ _id: oid(String(supplierId)), warehouseId });
  if (!s) fail(400, "VALIDATION_ERROR", "Choose a supplier from the list.");
  Object.assign(fields, { supplierId: s._id, supplier: s.name, supplierPhone: s.phone, supplierEmail: s.email });
}

const ENDPOINTS = [
  ["GET", "/health", false, "API and database health"],
  ["GET", "/api/docs", false, "Endpoint list"],
  ["POST", "/v1/auth/register", false, "Create owner account and warehouse"],
  ["POST", "/v1/auth/login", false, "Sign in and receive JWT"],
  ["GET", "/v1/me", true, "Current user and warehouse"],
  ["GET", "/v1/dashboard", true, "Dashboard totals"],
  ["GET", "/v1/categories", true, "Product categories"],
  ["GET", "/v1/products", true, "List products (?search=&category=)"],
  ["POST", "/v1/products", true, "Create product (optional opening stock, expiry, photos)"],
  ["GET", "/v1/products/lookup/:code", true, "Find by barcode / QR / SKU"],
  ["PATCH", "/v1/products/thresholds", true, "Bulk update low-stock thresholds"],
  ["GET", "/v1/products/:id", true, "Product details with batches"],
  ["PATCH", "/v1/products/:id", true, "Update product"],
  ["DELETE", "/v1/products/:id", true, "Archive product (owner only)"],
  ["POST", "/v1/stock/in", true, "Stock In one product"],
  ["POST", "/v1/stock/in/batch", true, "Save the push-to-talk review table (creates or updates by code)"],
  ["POST", "/v1/stock/out", true, "Stock Out / Ship Out"],
  ["POST", "/v1/stock/counts", true, "Save physical count"],
  ["POST", "/v1/voice/parse", true, "Parse a push-to-talk transcript"],
  ["GET", "/v1/movements", true, "Movement and adjustment history"],
  ["GET", "/v1/alerts", true, "Low-stock, out-of-stock and expiry alerts"],
  ["GET", "/v1/suppliers", true, "Supplier list with linked products"],
  ["POST", "/v1/suppliers", true, "Add supplier"],
  ["PATCH", "/v1/suppliers/:id", true, "Edit supplier (updates linked products)"],
  ["DELETE", "/v1/suppliers/:id", true, "Delete supplier (owner only)"],
  ["GET", "/v1/reorders", true, "Supplier reorders (?status=active)"],
  ["POST", "/v1/reorders", true, "Reorder from supplier"],
  ["PATCH", "/v1/reorders/:id", true, "Update reorder status"],
  ["GET", "/v1/warehouse", true, "Warehouse details and alert settings"],
  ["PATCH", "/v1/warehouse", true, "Update warehouse and alert settings (owner only)"]
];

// ---------- authenticated routes ----------
const v1 = new Elysia({ name: "v1", prefix: "/v1" })
  .derive(async ({ request }) => authenticate(request))

  .get("/me", ({ user, warehouse }) => ({ user: out(user), warehouse: warehouseOut(warehouse) }))
  .get("/categories", () => ({ items: CATEGORIES }))

  .get("/dashboard", async ({ db, warehouse }) => {
    const days = warehouseOut(warehouse).settings.expiryAlertDays;
    const [totals] = await db.collection("products").aggregate([
      { $match: { warehouseId: warehouse._id, archived: false } },
      { $group: {
        _id: null, products: { $sum: 1 }, units: { $sum: "$quantity" },
        outOfStock: { $sum: { $cond: [{ $lte: ["$quantity", 0] }, 1, 0] } },
        lowStock: { $sum: { $cond: [{ $and: [{ $gt: ["$quantity", 0] }, { $lte: ["$quantity", "$lowStockThreshold"] }] }, 1, 0] } }
      } }
    ]).toArray();
    const [expiring, pendingOrders, recent, usage, products] = await Promise.all([
      db.collection("batches").countDocuments({ warehouseId: warehouse._id, quantity: { $gt: 0 }, expiryDate: { $gt: "", $lte: addDays(days) } }),
      db.collection("reorders").countDocuments({ warehouseId: warehouse._id, status: { $in: ["PENDING", "CONFIRM_SHIPPING"] } }),
      db.collection("movements").find({ warehouseId: warehouse._id }).sort({ createdAt: -1 }).limit(6).toArray(),
      usageByProduct(db, warehouse._id),
      db.collection("products").find({ warehouseId: warehouse._id, archived: false }, { projection: { photos: 0 } }).toArray()
    ]);
    // Items predicted to run out within two weeks, soonest first.
    const runningOut = products
      .map((p) => ({ p, f: forecast(p, usage) }))
      .filter(({ f }) => f.daysLeft !== null && f.daysLeft <= 14)
      .sort((a, b) => a.f.daysLeft - b.f.daysLeft)
      .slice(0, 6)
      .map(({ p, f }) => ({ ...productOut(p), ...f }));
    const { _id, ...summary } = totals || {};
    return { products: 0, units: 0, outOfStock: 0, lowStock: 0, ...summary, expiring, pendingOrders, recent: recent.map(out), runningOut };
  })

  .get("/products", async ({ db, warehouse, query }) => {
    const search = str(query.search, 100);
    const category = str(query.category, 80);
    const match = { warehouseId: warehouse._id, archived: false };
    if (category) match.category = category;
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      match.$or = [{ name: re }, { sku: re }, { barcode: re }, { supplier: re }];
    }
    const rows = await db.collection("products").aggregate([
      { $match: match },
      { $sort: { name: 1 } },
      { $limit: 1000 },
      { $lookup: {
        from: "batches", let: { pid: "$_id" }, as: "nextExpiry",
        pipeline: [
          { $match: { $expr: { $eq: ["$productId", "$$pid"] }, quantity: { $gt: 0 }, expiryDate: { $gt: "" } } },
          { $sort: { expiryDate: 1 } }, { $limit: 1 }, { $project: { _id: 0, expiryDate: 1 } }
        ]
      } },
      { $addFields: { photoCount: { $size: { $ifNull: ["$photos", []] } }, nextExpiry: { $ifNull: [{ $first: "$nextExpiry.expiryDate" }, ""] } } },
      { $project: { photos: 0 } }
    ]).toArray();
    const usage = await usageByProduct(db, warehouse._id);
    return { items: rows.map((p) => ({ ...productOut(p), ...forecast(p, usage) })), total: rows.length };
  })

  .post("/products", async ({ db, warehouse, user, body }) => {
    const b = jsonBody(body);
    const fields = productFields(b);
    await applySupplier(db, warehouse._id, fields, b.supplierId);
    const initial = cleanInt(b.initialQuantity ?? 0);
    if (initial === null) fail(400, "VALIDATION_ERROR", "Quantity must be a non-negative whole number.");
    try {
      const product = await withTx(async (session, txDb) => {
        const now = new Date();
        const doc = { _id: new ObjectId(), warehouseId: warehouse._id, ...fields, quantity: 0, orderStatus: null, archived: false, createdAt: now, updatedAt: now };
        await txDb.collection("products").insertOne(doc, { session });
        if (initial > 0) {
          return stockIn(txDb, session, { warehouse, user, product: doc, qty: initial, type: "OPENING", reason: "Opening stock", note: "Product registration", expiryDate: b.expiryDate, batchNumber: b.batchNumber, stockInDate: b.stockInDate, remarks: b.remarks });
        }
        return doc;
      });
      return json(201, productOut(product));
    } catch (e) {
      if (e?.code === 11000) fail(409, "DUPLICATE_PRODUCT_CODE", "SKU or barcode already exists in this warehouse.");
      throw e;
    }
  })

  .get("/products/lookup/:code", async ({ db, warehouse, params }) => {
    const code = str(params.code, 80);
    const product = await db.collection("products").findOne({ warehouseId: warehouse._id, archived: false, $or: [{ barcode: code }, { sku: code }] });
    return { found: Boolean(product), product: productOut(product) || null, code };
  })

  // Bulk edit from Settings: each item may carry a low-stock threshold, a shelf life (days), or both.
  .patch("/products/thresholds", async ({ db, warehouse, body }) => {
    const items = Array.isArray(body?.items) ? body.items.slice(0, 1000) : [];
    const ops = [];
    for (const it of items) {
      const _id = oid(String(it.id || ""));
      if (!_id) fail(400, "VALIDATION_ERROR", "Unknown product.");
      const set = { updatedAt: new Date() };
      if (it.lowStockThreshold !== undefined) {
        const threshold = cleanInt(it.lowStockThreshold);
        if (threshold === null) fail(400, "VALIDATION_ERROR", "Each threshold must be a non-negative whole number.");
        set.lowStockThreshold = threshold;
      }
      if (it.shelfLifeDays !== undefined) {
        const days = it.shelfLifeDays === "" || it.shelfLifeDays === null ? 0 : cleanInt(it.shelfLifeDays);
        if (days === null || days > 3650) fail(400, "VALIDATION_ERROR", "Shelf life must be between 0 and 3650 days.");
        set.shelfLifeDays = days;
      }
      ops.push({ updateOne: { filter: { _id, warehouseId: warehouse._id }, update: { $set: set } } });
    }
    if (ops.length) await db.collection("products").bulkWrite(ops);
    return { updated: ops.length };
  })

  .get("/products/:id", async ({ db, warehouse, params }) => {
    const p = await findProduct(db, warehouse._id, params.id);
    const [batches, reorder] = await Promise.all([
      db.collection("batches").find({ productId: p._id, quantity: { $gt: 0 } }).sort({ expiryDate: 1 }).toArray(),
      db.collection("reorders").findOne({ productId: p._id, status: { $in: ["PENDING", "CONFIRM_SHIPPING"] } })
    ]);
    const usage = await usageByProduct(db, warehouse._id);
    return { ...productOut(p), ...forecast(p, usage), batches: batches.map(out), activeReorder: out(reorder) || null };
  })

  .patch("/products/:id", async ({ db, warehouse, params, body }) => {
    const old = await findProduct(db, warehouse._id, params.id);
    const fields = productFields(jsonBody(body), old);
    await applySupplier(db, warehouse._id, fields, body?.supplierId);
    try {
      const p = await db.collection("products").findOneAndUpdate({ _id: old._id }, { $set: { ...fields, updatedAt: new Date() } }, { returnDocument: "after" });
      return productOut(p);
    } catch (e) {
      if (e?.code === 11000) fail(409, "DUPLICATE_PRODUCT_CODE", "SKU or barcode already exists.");
      throw e;
    }
  })

  .delete("/products/:id", async ({ db, warehouse, user, params }) => {
    requireOwner(user);
    const p = await findProduct(db, warehouse._id, params.id);
    // Free the codes so the same barcode can be registered again later.
    await db.collection("products").updateOne({ _id: p._id }, { $set: { archived: true, sku: `${p.sku}#archived-${p._id}`, barcode: "", updatedAt: new Date() } });
    return json(204);
  })

  .post("/stock/in", async ({ db, warehouse, user, body }) => {
    const b = jsonBody(body);
    const qty = cleanInt(b.quantity, 1);
    if (qty === null) fail(400, "VALIDATION_ERROR", "Enter a positive whole-number quantity.");
    const result = await withTx(async (session, txDb) => {
      const product = await findProduct(txDb, warehouse._id, b.productId, session);
      return stockIn(txDb, session, {
        warehouse, user, product, qty, reason: b.reason, reference: b.reference, note: b.note,
        expiryDate: b.expiryDate, batchNumber: b.batchNumber, stockInDate: b.stockInDate, remarks: b.remarks
      });
    });
    return { product: productOut(result), before: result.quantity - qty, after: result.quantity, movementType: "IN" };
  })

  // Push-to-talk review table: each row is keyed by the scanned code. Existing products are
  // updated and stocked in; unknown codes become the unique ID of a new product.
  .post("/stock/in/batch", async ({ db, warehouse, user, body }) => {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length || items.length > 100) fail(400, "VALIDATION_ERROR", "Add between 1 and 100 items before saving.");
    for (const [i, it] of items.entries()) {
      if (!str(it.name) && !str(it.code)) fail(400, "VALIDATION_ERROR", `Row ${i + 1}: a product name or code is required.`);
      if (cleanInt(it.quantity, 1) === null) fail(400, "VALIDATION_ERROR", `Row ${i + 1}: quantity must be a positive whole number.`);
    }
    try {
      const saved = await withTx(async (session, txDb) => {
        const results = [];
        for (const it of items) {
          const code = str(it.code, 80), name = str(it.name, 160), qty = cleanInt(it.quantity, 1);
          const products = txDb.collection("products");
          let product = code
            ? await products.findOne({ warehouseId: warehouse._id, archived: false, $or: [{ barcode: code }, { sku: code }] }, { session })
            : await products.findOne({ warehouseId: warehouse._id, archived: false, name: new RegExp(`^${escapeRegex(name)}$`, "i") }, { session });
          let created = false;
          if (product) {
            const set = { updatedAt: new Date() };
            if (name) set.name = name;
            if (str(it.description)) set.description = str(it.description, 2000);
            if (str(it.unit)) set.unit = str(it.unit, 40);
            if (str(it.remarks)) set.remarks = str(it.remarks, 1000);
            if (str(it.category)) set.category = str(it.category, 80);
            await products.updateOne({ _id: product._id }, { $set: set }, { session });
            product = { ...product, ...set };
          } else {
            const fields = productFields({ ...it, name: name || code, sku: code, barcode: code, remarks: it.remarks });
            const now = new Date();
            product = { _id: new ObjectId(), warehouseId: warehouse._id, ...fields, quantity: 0, orderStatus: null, archived: false, createdAt: now, updatedAt: now };
            await products.insertOne(product, { session });
            created = true;
          }
          const updated = await stockIn(txDb, session, {
            warehouse, user, product, qty, type: created ? "OPENING" : "IN",
            reason: "Push-to-talk stock in", note: "", remarks: it.remarks, expiryDate: it.expiryDate, stockInDate: it.stockInDate
          });
          results.push({ ...productOut(updated), created });
        }
        return results;
      });
      return { items: saved };
    } catch (e) {
      if (e?.code === 11000) fail(409, "DUPLICATE_PRODUCT_CODE", "Two rows use the same new code. Merge them and try again.");
      throw e;
    }
  })

  .post("/stock/out", async ({ db, warehouse, user, body }) => {
    const b = jsonBody(body);
    const qty = cleanInt(b.quantity, 1);
    if (qty === null) fail(400, "VALIDATION_ERROR", "Enter a positive whole-number quantity.");
    const result = await withTx(async (session, txDb) => {
      const product = await findProduct(txDb, warehouse._id, b.productId, session);
      // The quantity filter makes the check-and-decrement atomic, so stock can never go negative.
      const updated = await txDb.collection("products").findOneAndUpdate(
        { _id: product._id, archived: false, quantity: { $gte: qty } },
        { $inc: { quantity: -qty }, $set: { updatedAt: new Date() } },
        { returnDocument: "after", session }
      );
      if (!updated) fail(409, "INSUFFICIENT_STOCK", `Only ${product.quantity} ${product.unit} available.`);
      await consumeBatches(txDb, session, warehouse._id, product._id, qty);
      await recordMovement(txDb, session, {
        warehouse, user, product: updated, type: "OUT", delta: -qty, beforeQty: updated.quantity + qty,
        afterQty: updated.quantity, reason: b.reason || "Ship out", reference: b.reference, note: b.note || b.destination
      });
      return updated;
    });
    return { product: productOut(result), before: result.quantity + qty, after: result.quantity, movementType: "OUT" };
  })

  .post("/stock/counts", async ({ db, warehouse, user, body }) => {
    const b = jsonBody(body);
    const counted = cleanInt(b.countedQuantity);
    if (counted === null) fail(400, "VALIDATION_ERROR", "Enter a non-negative whole-number count.");
    const result = await withTx(async (session, txDb) => {
      const p = await findProduct(txDb, warehouse._id, b.productId, session);
      if (counted !== p.quantity && !str(b.reason)) fail(400, "REASON_REQUIRED", "A reason is required when the physical count differs from system stock.");
      const updated = await txDb.collection("products").findOneAndUpdate(
        { _id: p._id, quantity: p.quantity },
        { $set: { quantity: counted, updatedAt: new Date() } },
        { returnDocument: "after", session }
      );
      if (!updated) fail(409, "STOCK_CHANGED", "Stock changed during the count. Refresh and confirm again.");
      if (counted < p.quantity) await consumeBatches(txDb, session, warehouse._id, p._id, p.quantity - counted);
      await recordMovement(txDb, session, {
        warehouse, user, product: updated, type: "COUNT_ADJUSTMENT", delta: counted - p.quantity,
        beforeQty: p.quantity, afterQty: counted, reason: b.reason || "Physical count matched", note: b.note
      });
      return { updated, before: p.quantity };
    });
    return { product: productOut(result.updated), before: result.before, counted, delta: counted - result.before };
  })

  .post("/voice/parse", ({ body }) => parseVoice(str(body?.text, 1000)))

  .get("/movements", async ({ db, warehouse, query }) => {
    const filter = { warehouseId: warehouse._id };
    if (query.productId) filter.productId = oid(String(query.productId));
    if (query.type) filter.type = str(query.type, 30);
    const rows = await db.collection("movements").find(filter).sort({ createdAt: -1 }).limit(500).toArray();
    return { items: rows.map(out) };
  })

  .get("/alerts", async ({ db, warehouse }) => {
    const days = warehouseOut(warehouse).settings.expiryAlertDays;
    const base = { warehouseId: warehouse._id, archived: false };
    const proj = { projection: { photos: 0 } };
    const [outRows, lowRows, healthyRows, usage, batches] = await Promise.all([
      db.collection("products").find({ ...base, quantity: { $lte: 0 } }, proj).sort({ name: 1 }).toArray(),
      db.collection("products").find({ ...base, quantity: { $gt: 0 }, $expr: { $lte: ["$quantity", "$lowStockThreshold"] } }, proj).sort({ quantity: 1 }).toArray(),
      db.collection("products").find({ ...base, $expr: { $gt: ["$quantity", "$lowStockThreshold"] } }, proj).toArray(),
      usageByProduct(db, warehouse._id),
      db.collection("batches").aggregate([
        { $match: { warehouseId: warehouse._id, quantity: { $gt: 0 }, expiryDate: { $gt: "", $lte: addDays(days) } } },
        { $sort: { expiryDate: 1 } },
        { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "p" } },
        { $unwind: "$p" },
        { $match: { "p.archived": false } }
      ]).toArray()
    ]);
    const now = today();
    const items = [
      ...outRows.map((p) => ({ type: "OUT_OF_STOCK", productId: String(p._id), name: p.name, sku: p.sku, quantity: p.quantity, unit: p.unit, threshold: p.lowStockThreshold, orderStatus: p.orderStatus })),
      ...lowRows.map((p) => ({ type: "LOW_STOCK", productId: String(p._id), name: p.name, sku: p.sku, quantity: p.quantity, unit: p.unit, threshold: p.lowStockThreshold, orderStatus: p.orderStatus })),
      // Predictive: still above its threshold, but at the current pace it will be gone within a week.
      ...healthyRows.map((p) => ({ p, f: forecast(p, usage) })).filter(({ f }) => f.daysLeft !== null && f.daysLeft <= 7)
        .sort((a, b) => a.f.daysLeft - b.f.daysLeft)
        .map(({ p, f }) => ({ type: "RUNNING_OUT", productId: String(p._id), name: p.name, sku: p.sku, quantity: p.quantity, unit: p.unit, threshold: p.lowStockThreshold, orderStatus: p.orderStatus, ...f })),
      ...batches.map((b) => ({
        type: b.expiryDate < now ? "EXPIRED" : "EXPIRY", productId: String(b.productId), batchId: String(b._id), name: b.p.name, sku: b.p.sku,
        quantity: b.quantity, unit: b.p.unit, expiryDate: b.expiryDate,
        daysLeft: Math.round((new Date(b.expiryDate) - new Date(now)) / 86_400_000)
      }))
    ];
    return { items, expiryAlertDays: days };
  })

  .get("/suppliers", async ({ db, warehouse }) => {
    await adoptProductSuppliers(db, warehouse._id);
    const [suppliers, products, open] = await Promise.all([
      db.collection("suppliers").find({ warehouseId: warehouse._id }).sort({ name: 1 }).toArray(),
      db.collection("products").find({ warehouseId: warehouse._id, archived: false, supplierId: { $ne: null } }, { projection: { name: 1, supplierId: 1 } }).toArray(),
      db.collection("reorders").aggregate([
        { $match: { warehouseId: warehouse._id, status: { $in: ["PENDING", "CONFIRM_SHIPPING"] } } },
        { $group: { _id: "$supplier", n: { $sum: 1 } } }
      ]).toArray()
    ]);
    const openBy = new Map(open.map((o) => [o._id, o.n]));
    return { items: suppliers.map((s) => {
      const mine = products.filter((p) => String(p.supplierId) === String(s._id));
      return { ...out(s), productCount: mine.length, products: mine.map((p) => ({ id: String(p._id), name: p.name })), openOrders: openBy.get(s.name) || 0 };
    }) };
  })

  .post("/suppliers", async ({ db, warehouse, body }) => {
    const now = new Date();
    const doc = { _id: new ObjectId(), warehouseId: warehouse._id, ...supplierFields(jsonBody(body)), createdAt: now, updatedAt: now };
    try { await db.collection("suppliers").insertOne(doc); }
    catch (e) { if (e?.code === 11000) fail(409, "SUPPLIER_EXISTS", "A supplier with this name already exists."); throw e; }
    return json(201, { ...out(doc), productCount: 0, products: [], openOrders: 0 });
  })

  .patch("/suppliers/:id", async ({ db, warehouse, params, body }) => {
    const old = await db.collection("suppliers").findOne({ _id: oid(params.id), warehouseId: warehouse._id });
    if (!old) fail(404, "NOT_FOUND", "Supplier not found.");
    let s;
    try {
      s = await db.collection("suppliers").findOneAndUpdate({ _id: old._id }, { $set: { ...supplierFields(jsonBody(body), old), updatedAt: new Date() } }, { returnDocument: "after" });
    } catch (e) { if (e?.code === 11000) fail(409, "SUPPLIER_EXISTS", "A supplier with this name already exists."); throw e; }
    await syncProductsToSupplier(db, s);
    return out(s);
  })

  .delete("/suppliers/:id", async ({ db, warehouse, user, params }) => {
    requireOwner(user);
    const s = await db.collection("suppliers").findOne({ _id: oid(params.id), warehouseId: warehouse._id });
    if (!s) fail(404, "NOT_FOUND", "Supplier not found.");
    // Products keep the supplier's name as text; only the link is removed.
    await db.collection("products").updateMany({ warehouseId: s.warehouseId, supplierId: s._id }, { $set: { supplierId: null } });
    await db.collection("suppliers").deleteOne({ _id: s._id });
    return json(204);
  })

  .get("/reorders", async ({ db, warehouse, query }) => {
    const filter = { warehouseId: warehouse._id };
    if (query.status === "active") filter.status = { $in: ["PENDING", "CONFIRM_SHIPPING"] };
    const rows = await db.collection("reorders").find(filter).sort({ createdAt: -1 }).limit(300).toArray();
    return { items: rows.map(out) };
  })

  .post("/reorders", async ({ db, warehouse, user, body }) => {
    const b = jsonBody(body);
    const qty = cleanInt(b.quantity, 1);
    if (qty === null) fail(400, "VALIDATION_ERROR", "Enter a positive whole-number quantity to reorder.");
    const reorder = await withTx(async (session, txDb) => {
      const p = await findProduct(txDb, warehouse._id, b.productId, session);
      const active = await txDb.collection("reorders").findOne({ productId: p._id, status: { $in: ["PENDING", "CONFIRM_SHIPPING"] } }, { session });
      if (active) fail(409, "REORDER_EXISTS", "There is already an open order for this product.");
      const now = new Date();
      const doc = {
        _id: new ObjectId(), warehouseId: warehouse._id, productId: p._id, productName: p.name, sku: p.sku, unit: p.unit,
        supplier: str(b.supplier, 160) || p.supplier, supplierPhone: str(b.supplierPhone, 60) || p.supplierPhone || "",
        quantity: qty, note: str(b.note, 1000), status: "PENDING", history: [{ status: "PENDING", at: now, by: user.name }],
        createdAt: now, updatedAt: now
      };
      await txDb.collection("reorders").insertOne(doc, { session });
      await txDb.collection("products").updateOne({ _id: p._id }, { $set: { orderStatus: "PENDING", updatedAt: now } }, { session });
      return doc;
    });
    return json(201, out(reorder));
  })

  .patch("/reorders/:id", async ({ db, warehouse, user, params, body }) => {
    const nextStatus = str(body?.status, 30);
    const result = await withTx(async (session, txDb) => {
      const r = await txDb.collection("reorders").findOne({ _id: oid(params.id), warehouseId: warehouse._id }, { session });
      if (!r) fail(404, "NOT_FOUND", "Order not found.");
      if (!(REORDER_FLOW[r.status] || []).includes(nextStatus)) fail(400, "INVALID_STATUS", `An order that is ${r.status} cannot move to ${nextStatus || "that status"}.`);
      const now = new Date();
      const received = nextStatus === "RECEIVED" ? cleanInt(body?.receivedQuantity ?? r.quantity, 1) : null;
      if (nextStatus === "RECEIVED" && received === null) fail(400, "VALIDATION_ERROR", "Received quantity must be a positive whole number.");
      const updated = await txDb.collection("reorders").findOneAndUpdate(
        { _id: r._id, status: r.status },
        { $set: { status: nextStatus, updatedAt: now, ...(received ? { receivedQuantity: received } : {}) }, $push: { history: { status: nextStatus, at: now, by: user.name } } },
        { returnDocument: "after", session }
      );
      if (!updated) fail(409, "ORDER_CHANGED", "The order changed. Refresh and try again.");
      const product = await txDb.collection("products").findOne({ _id: r.productId }, { session });
      if (product) {
        await txDb.collection("products").updateOne({ _id: r.productId }, { $set: { orderStatus: ["RECEIVED", "CANCELLED"].includes(nextStatus) ? null : nextStatus, updatedAt: now } }, { session });
        if (received && !product.archived) {
          await stockIn(txDb, session, { warehouse, user, product, qty: received, reason: "Supplier order received", reference: `ORDER-${String(r._id).slice(-6).toUpperCase()}`, note: r.supplier, expiryDate: body?.expiryDate });
        }
      }
      return updated;
    });
    return out(result);
  })

  .get("/warehouse", ({ warehouse }) => warehouseOut(warehouse))
  .patch("/warehouse", async ({ db, warehouse, user, body }) => {
    requireOwner(user);
    const b = jsonBody(body);
    const current = warehouseOut(warehouse);
    const set = {
      name: b.name !== undefined ? str(b.name, 120) : current.name,
      location: b.location !== undefined ? str(b.location, 160) : current.location,
      language: ["en", "my"].includes(b.language) ? b.language : current.language,
      settings: { ...current.settings }
    };
    if (!set.name) fail(400, "VALIDATION_ERROR", "Warehouse name is required.");
    if (b.settings?.expiryAlertDays !== undefined) {
      const d = cleanInt(b.settings.expiryAlertDays, 1);
      if (d === null || d > 365) fail(400, "VALIDATION_ERROR", "Expiry reminder must be between 1 and 365 days.");
      set.settings.expiryAlertDays = d;
    }
    if (b.settings?.defaultLowStockThreshold !== undefined) {
      const t = cleanInt(b.settings.defaultLowStockThreshold);
      if (t === null) fail(400, "VALIDATION_ERROR", "Default threshold must be a non-negative whole number.");
      set.settings.defaultLowStockThreshold = t;
    }
    const w = await db.collection("warehouses").findOneAndUpdate({ _id: warehouse._id }, { $set: set }, { returnDocument: "after" });
    return warehouseOut(w);
  });

// `node()` keeps `app.listen()` working on Node 22.18+; Bun and Vercel's fetch handler don't need it.
const adapter = typeof Bun === "undefined" && !process.env.VERCEL ? node() : undefined;

export const app = new Elysia({ adapter })
  .onRequest(({ request, set }) => {
    beginRequest(request, set);
    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_BODY_BYTES) {
      set.status = 413;
      return json(413, { error: "TOO_LARGE", message: "Photos are too large. Use fewer or smaller images." });
    }
  })
  .use(cors({
    origin: origins,
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization"]
  }))
  .onAfterResponse(({ request, set, responseValue, user }) => {
    endRequest({ request, set, response: responseValue, user });
  })
  .mapResponse(({ request, responseValue }) => {
    noteResponse(request, responseValue);
  })
  .onError(({ error, request }) => {
    if (error?.status && error?.error) return json(error.status, { error: error.error, message: error.message });
    if (error instanceof ParseError) return json(400, { error: "VALIDATION_ERROR", message: "The request body is not valid JSON." });
    if (error instanceof NotFound) return json(404, { error: "NOT_FOUND", message: `No route for ${request.method} ${new URL(request.url).pathname}` });
    const message = String(error?.message || error?.name || "");
    const dbDown = /ECONNREFUSED|Server selection timed out|MongoServerSelectionError/i.test(`${error?.name || ""} ${message}`);
    log.error("Unhandled request error", {
      requestId: requestIdOf(request),
      method: request.method,
      path: new URL(request.url).pathname,
      error
    });
    return json(dbDown ? 503 : 500, dbDown
      ? { error: "DATABASE_UNAVAILABLE", message: "Cannot reach the MongoDB database. Check that it is running and MONGODB_URI is correct." }
      : { error: "INTERNAL_ERROR", message: "Unexpected server error." });
  })

  .get("/health", async () => {
    const db = await getDb();
    await db.command({ ping: 1 });
    return { ok: true, service: "invento-api", database: "mongodb", time: new Date().toISOString() };
  })

  .get("/api/docs", () => ({
    service: "Invento API",
    note: "Authenticated /v1 routes require Authorization: Bearer <token>. Login via POST /v1/auth/login.",
    endpoints: ENDPOINTS.map(([method, path, authRequired, description]) => ({ method, path, auth: authRequired, description }))
  }))

  .post("/v1/auth/register", async ({ body }) => {
    const { name, email, password, warehouseName, location = "" } = jsonBody(body);
    if (!str(name) || !str(email) || typeof password !== "string" || password.length < 10 || !str(warehouseName)) {
      fail(400, "VALIDATION_ERROR", "Name, email, warehouse name, and password (at least 10 characters) are required.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(email))) fail(400, "VALIDATION_ERROR", "Enter a valid email address.");
    const userId = new ObjectId(), warehouseId = new ObjectId(), now = new Date();
    const user = { _id: userId, name: str(name, 120), email: str(email, 160).toLowerCase(), passwordHash: bcrypt.hashSync(password, 12), role: "OWNER", warehouseId, createdAt: now };
    const warehouse = { _id: warehouseId, ownerId: userId, name: str(warehouseName, 120), location: str(location, 160), language: "en", timezone: "Asia/Yangon", settings: { ...defaultSettings }, createdAt: now };
    try {
      await withTx(async (session, db) => {
        await db.collection("users").insertOne(user, { session });
        await db.collection("warehouses").insertOne(warehouse, { session });
      });
    } catch (e) {
      if (e?.code === 11000) fail(409, "EMAIL_EXISTS", "That email is already registered.");
      throw e;
    }
    return json(201, { token: sign(user), user: out(user), warehouse: warehouseOut(warehouse) });
  })

  .post("/v1/auth/login", async ({ body }) => {
    const db = await getDb();
    const b = jsonBody(body);
    const email = str(b.email).toLowerCase();
    const password = String(b.password || "");
    const user = await db.collection("users").findOne({ email });
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) fail(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    const warehouse = await db.collection("warehouses").findOne({ _id: user.warehouseId });
    return { token: sign(user), user: out(user), warehouse: warehouseOut(warehouse) };
  })

  .use(v1);
