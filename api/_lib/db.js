import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";

// Files and folders starting with "_" inside api/ are not turned into Vercel functions,
// so shared code lives here and both api/server.js (local) and api/index.js (Vercel) import it.

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGODB_DB || "invento";

// Reuse one client across hot reloads and warm serverless invocations.
const g = globalThis;
g.__invento ||= { client: null, ready: null };

export const DEMO = { email: "demo@invento.local", password: "InventoDemo!2026" };

export async function getDb() {
  if (!g.__invento.ready) {
    g.__invento.ready = (async () => {
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10 });
      await client.connect();
      const db = client.db(dbName);
      // Multi-document transactions need a replica set (MongoDB Atlas always is one).
      // A plain local `mongod` is standalone, so we fall back to ordered writes there.
      const hello = await db.admin().command({ hello: 1 }).catch(() => ({}));
      const supportsTx = Boolean(hello.setName || hello.msg === "isdbgrid");
      g.__invento.client = client;
      g.__invento.supportsTx = supportsTx;
      await ensureIndexes(db);
      if (process.env.SEED_DEMO !== "false") await seedDemo(db);
      return db;
    })().catch((e) => { g.__invento.ready = null; throw e; });
  }
  return g.__invento.ready;
}

/** Closes the shared client so `node server.js` can exit on SIGINT/SIGTERM. */
export async function closeDb() {
  const client = g.__invento.client;
  g.__invento = { client: null, ready: null };
  if (client) await client.close();
}

/** Runs fn(session) in a transaction when the server supports it, otherwise without one. */
export async function withTx(fn) {
  const db = await getDb();
  if (!g.__invento.supportsTx) return fn(undefined, db);
  const session = g.__invento.client.startSession();
  let result;
  try {
    await session.withTransaction(async () => { result = await fn(session, db); });
    return result;
  } finally {
    await session.endSession();
  }
}

export const oid = (value) => (typeof value === "string" && ObjectId.isValid(value) && value.length === 24 ? new ObjectId(value) : null);

async function ensureIndexes(db) {
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("warehouses").createIndex({ ownerId: 1 }),
    db.collection("products").createIndex({ warehouseId: 1, sku: 1 }, { unique: true }),
    db.collection("products").createIndex(
      { warehouseId: 1, barcode: 1 },
      { unique: true, partialFilterExpression: { barcode: { $type: "string", $gt: "" } } }
    ),
    db.collection("products").createIndex({ warehouseId: 1, archived: 1, name: 1 }),
    db.collection("batches").createIndex({ warehouseId: 1, productId: 1, expiryDate: 1 }),
    db.collection("movements").createIndex({ warehouseId: 1, createdAt: -1 }),
    db.collection("movements").createIndex({ warehouseId: 1, productId: 1, createdAt: -1 }),
    db.collection("reorders").createIndex({ warehouseId: 1, status: 1, createdAt: -1 }),
    db.collection("suppliers").createIndex({ warehouseId: 1, name: 1 }, { unique: true })
  ]);
}

export const defaultSettings = { expiryAlertDays: 30, defaultLowStockThreshold: 5 };

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function seedDemo(db) {
  if (await db.collection("users").countDocuments({}, { limit: 1 })) return;
  const now = new Date();
  const userId = new ObjectId();
  const warehouseId = new ObjectId();
  try {
    await db.collection("users").insertOne({
      _id: userId, name: "Demo Owner", email: DEMO.email,
      passwordHash: bcrypt.hashSync(DEMO.password, 10), role: "OWNER", warehouseId, createdAt: now
    });
  } catch (e) {
    if (e?.code === 11000) return; // another cold start seeded first
    throw e;
  }
  await db.collection("warehouses").insertOne({
    _id: warehouseId, ownerId: userId, name: "Yangon Demo Warehouse", location: "Yangon, Myanmar",
    language: "en", timezone: "Asia/Yangon", settings: { ...defaultSettings }, createdAt: now
  });
  await seedDemoStock(db, { warehouseId, userId, userName: "Demo Owner" });
}

// The PRD demo scenario (noodles, bottled water, bread) plus a few more lines. `perDay` is the
// average daily ship-out used to build 30 days of history, so the restock forecast has real data.
const DEMO_PRODUCTS = [
  { name: "Instant Noodles", sku: "890100000001", category: "Food & Beverage", unit: "packs", supplier: "Golden Myanmar Trading", supplierPhone: "09 420 000 111", lowStockThreshold: 20, quantity: 40, perDay: 6, expiryIn: 60 },
  { name: "Bottled Water 600ml", sku: "890100000002", category: "Food & Beverage", unit: "bottles", supplier: "Shwe Pyi Supplier", supplierPhone: "09 420 000 222", lowStockThreshold: 24, quantity: 12, perDay: 4, expiryIn: 180 },
  { name: "White Bread", sku: "890100000003", category: "Food & Beverage", unit: "loaves", supplier: "City Bakery", supplierPhone: "09 420 000 333", lowStockThreshold: 10, quantity: 6, perDay: 2, expiryIn: 3, shelfLifeDays: 4 },
  { name: "Cooking Oil 1L", sku: "890100000006", category: "Food & Beverage", unit: "bottles", supplier: "Shwe Pyi Supplier", supplierPhone: "09 420 000 222", lowStockThreshold: 10, quantity: 30, perDay: 3, expiryIn: 240 },
  { name: "Laundry Powder 1kg", sku: "890100000004", category: "Household", unit: "bags", supplier: "Mandalay Wholesale", supplierPhone: "09 420 000 444", lowStockThreshold: 8, quantity: 0, perDay: 1 },
  { name: "Toothpaste 100g", sku: "890100000005", category: "Personal Care", unit: "tubes", supplier: "Golden Myanmar Trading", supplierPhone: "09 420 000 111", lowStockThreshold: 10, quantity: 28, perDay: 1 },
  { name: "Rice 5kg", sku: "890100000007", category: "Food & Beverage", unit: "bags", supplier: "Ayeyarwady Rice Mill", supplierPhone: "09 420 000 555", lowStockThreshold: 10, quantity: 50, perDay: 0.5, expiryIn: 165, shelfLifeDays: 180 },
  // Undated local goods: their expiry comes from shelf life, not a printed date.
  { name: "Eggs (30 tray)", sku: "890100000008", category: "Food & Beverage", unit: "trays", supplier: "Hlegu Poultry Farm", supplierPhone: "09 420 000 666", lowStockThreshold: 5, quantity: 14, perDay: 2, expiryIn: 6, shelfLifeDays: 21 },
  { name: "Fresh Tomatoes", sku: "890100000009", category: "Agriculture", unit: "kg", supplier: "Thiri Mingalar Market", supplierPhone: "09 420 000 777", lowStockThreshold: 10, quantity: 18, perDay: 4, expiryIn: 2, shelfLifeDays: 5 }
];
const OUT_REASONS = ["Shop delivery", "Wholesale order", "Market stall", "Customer order"];

/** Creates the demo products with a consistent 30-day history: opening stock, one restock, daily ship-outs. */
export async function seedDemoStock(db, { warehouseId, userId, userName }, only) {
  const day = 86_400_000;
  const start = Date.now() - 30 * day;
  for (const [k, s] of DEMO_PRODUCTS.entries()) {
    if (only && !only.includes(s.sku)) continue;
    const productId = new ObjectId();
    // Deterministic day-to-day variation (60%–140% of the average) so charts look real but reproducible.
    const outs = Array.from({ length: 30 }, (_, i) => Math.round(s.perDay * (0.6 + 0.8 * (((i * 7 + k * 13) % 10) / 10))));
    const shipped = outs.reduce((a, b) => a + b, 0);
    // Restocking exactly the second half's sales keeps stock at or above today's level throughout.
    const restock = outs.slice(15).reduce((a, b) => a + b, 0);
    const opening = s.quantity + shipped - restock;
    const base = { warehouseId, productId, actorId: userId, productName: s.name, sku: s.sku, actorName: userName, reference: "", note: "", batchId: null };
    const moves = [];
    let qty = opening;
    moves.push({ ...base, type: "OPENING", delta: opening, beforeQty: 0, afterQty: opening, reason: "Initial stock", createdAt: new Date(start) });
    outs.forEach((n, i) => {
      if (i === 15) {
        moves.push({ ...base, type: "IN", delta: restock, beforeQty: qty, afterQty: qty + restock, reason: "Supplier delivery", reference: `PO-${1001 + k}`, createdAt: new Date(start + i * day + 9 * 3_600_000) });
        qty += restock;
      }
      if (n > 0) {
        moves.push({ ...base, type: "OUT", delta: -n, beforeQty: qty, afterQty: qty - n, reason: OUT_REASONS[(i + k) % OUT_REASONS.length], createdAt: new Date(start + i * day + 15 * 3_600_000) });
        qty -= n;
      }
    });
    const created = new Date(start - 5 * day);
    await db.collection("products").insertOne({
      _id: productId, warehouseId, name: s.name, description: "", sku: s.sku, barcode: s.sku, category: s.category,
      unit: s.unit, supplier: s.supplier, supplierPhone: s.supplierPhone, supplierEmail: "", fdaCode: "", photos: [],
      remarks: "", lowStockThreshold: s.lowStockThreshold, shelfLifeDays: s.shelfLifeDays || 0, quantity: qty, orderStatus: null, archived: false,
      createdAt: created, updatedAt: new Date()
    });
    if (s.expiryIn && qty > 0) {
      await db.collection("batches").insertOne({ warehouseId, productId, lotNumber: "", expiryDate: addDays(s.expiryIn), stockInDate: addDays(-15), quantity: qty, remarks: "", createdAt: new Date() });
    }
    await db.collection("movements").insertMany(moves);
  }
}

/**
 * Non-destructive demo update: sets shelf life on existing demo products and adds any demo
 * products that are missing (with their history). Nothing the user entered is removed.
 */
export async function ensureDemoProducts(db) {
  const user = await db.collection("users").findOne({ email: DEMO.email });
  if (!user) return { updated: 0, added: [] };
  const existing = await db.collection("products").find({ warehouseId: user.warehouseId, archived: false }, { projection: { sku: 1 } }).toArray();
  const have = new Set(existing.map((p) => p.sku));
  let updated = 0;
  for (const s of DEMO_PRODUCTS) {
    if (!have.has(s.sku)) continue;
    const r = await db.collection("products").updateOne({ warehouseId: user.warehouseId, sku: s.sku }, { $set: { shelfLifeDays: s.shelfLifeDays || 0 } });
    updated += r.modifiedCount;
  }
  const added = DEMO_PRODUCTS.filter((s) => !have.has(s.sku)).map((s) => s.sku);
  if (added.length) await seedDemoStock(db, { warehouseId: user.warehouseId, userId: user._id, userName: user.name }, added);
  return { updated, added };
}

/** Wipes and rebuilds only the demo account's stock (used by api/scripts/reset-demo.js). */
export async function resetDemoWarehouse(db) {
  const user = await db.collection("users").findOne({ email: DEMO.email });
  if (!user) return { reset: false, reason: "Demo user not found" };
  const warehouseId = user.warehouseId;
  const filter = { warehouseId };
  const removed = {};
  for (const c of ["products", "batches", "movements", "reorders"]) removed[c] = (await db.collection(c).deleteMany(filter)).deletedCount;
  await db.collection("warehouses").updateOne({ _id: warehouseId }, { $set: { settings: { ...defaultSettings } } });
  await seedDemoStock(db, { warehouseId, userId: user._id, userName: user.name });
  return { reset: true, removed };
}
