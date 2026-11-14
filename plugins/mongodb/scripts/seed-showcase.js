// Seeds `qmongo_showcase`, a database with made-up data covering what the plugin's explorer and query bar show:
// views (including a view on a view), time-series, GridFS buckets, system collections (profile, js, views, buckets),
// validators with non-default level/action, capped, clustered and empty collections, many index kinds, every BSON
// type, nested and mixed-type fields, and more documents than the field sample.
//
// Re-runnable: drops and recreates the database. Leaves profiling on for it (level 1, slowms 100).
//
//   mongosh mongodb://localhost:27017 plugins/mongodb/scripts/seed-showcase.js
//
// Or, with MongoDB in Docker:
//
//   docker cp plugins/mongodb/scripts/seed-showcase.js <container>:/tmp/ && docker exec <container> mongosh --quiet /tmp/seed-showcase.js
const DB = "qmongo_showcase";
const d = db.getSiblingDB(DB);
d.setProfilingLevel(0);
d.dropDatabase();

// Deterministic pseudo-random, so every run gives the same data
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const now = new Date("2026-11-14T12:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * 86400000 - int(0, 86399) * 1000);

const cities = ["Gothenburg", "Stockholm", "Malmö", "Oslo", "Copenhagen", "Helsinki", "Berlin", "Amsterdam"];
const countries = { Gothenburg: "SE", Stockholm: "SE", "Malmö": "SE", Oslo: "NO", Copenhagen: "DK", Helsinki: "FI", Berlin: "DE", Amsterdam: "NL" };
const first = ["Alex", "Sam", "Robin", "Kim", "Charlie", "Jamie", "Noa", "Mika", "Ellis", "Toni"];
const last = ["Lind", "Berg", "Ek", "Strand", "Holm", "Dahl", "Sjö", "Lund"];
const statuses = ["new", "paid", "shipped", "delivered", "cancelled", "returned"];
const tiers = ["bronze", "silver", "gold", "platinum"];
const categories = ["shoes", "outdoor", "kitchen", "books", "toys", "garden"];

// ---- customers: $jsonSchema validator (strict / error = defaults), nested address, arrays, mixed presence
d.createCollection("customers", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["name", "email", "tier"],
      properties: {
        name: { bsonType: "string" },
        email: { bsonType: "string", pattern: "^.+@.+$" },
        tier: { enum: tiers },
        address: { bsonType: "object", properties: { city: { bsonType: "string" }, zip: { bsonType: "string" } } }
      }
    }
  }
});
const customers = [];
for (let i = 1; i <= 400; i++) {
  const city = pick(cities);
  const c = {
    _id: i,
    name: `${pick(first)} ${pick(last)}`,
    email: `customer${i}@example.com`,
    tier: pick(tiers),
    createdAt: daysAgo(int(1, 900)),
    address: { street: `Testgatan ${int(1, 120)}`, zip: String(int(10000, 99999)), city, country: countries[city], geo: { lat: 57 + rnd() * 3, lng: 11 + rnd() * 8 } },
    tags: Array.from({ length: int(0, 3) }, () => pick(["vip", "newsletter", "b2b", "returns-often", "early-adopter"])),
    marketing: { email: rnd() > 0.3, sms: rnd() > 0.7 }
  };
  if (rnd() > 0.6) c.phone = `+46 70 ${int(100, 999)} ${int(10, 99)} ${int(10, 99)}`;
  if (rnd() > 0.85) c.notes = null;
  if (rnd() > 0.9) c.loyaltyPoints = NumberLong(String(int(0, 2000000)));
  customers.push(c);
}
d.customers.insertMany(customers);
d.customers.createIndex({ email: 1 }, { unique: true, name: "email_unique" });
d.customers.createIndex({ "address.city": 1, tier: 1 });
d.customers.createIndex({ phone: 1 }, { sparse: true });

// ---- orders: 2,500 docs (beyond the 1,000-doc sample, for paging), many BSON types, array of subdocuments
const orders = [];
for (let i = 1; i <= 2500; i++) {
  const items = Array.from({ length: int(1, 5) }, () => ({ sku: `SKU-${int(1000, 1299)}`, qty: int(1, 4), price: NumberDecimal((int(49, 2999) + 0.95).toFixed(2)) }));
  const total = items.reduce((s, it) => s + it.qty * parseFloat(it.price.toString()), 0);
  const o = {
    orderNo: `ORD-${String(i).padStart(6, "0")}`,
    customerId: int(1, 400),
    status: pick(statuses),
    createdAt: daysAgo(int(0, 365)),
    items,
    total: NumberDecimal(total.toFixed(2)),
    currency: pick(["SEK", "SEK", "SEK", "NOK", "DKK", "EUR"]),
    express: rnd() > 0.8,
    shipping: { method: pick(["post", "home", "pickup"]), cost: int(0, 99), tracking: rnd() > 0.4 ? UUID() : null }
  };
  if (rnd() > 0.7) o.notes = pick(["Leave at the door", "Gift wrap please", "Call before delivery", "Fragile items inside"]);
  if (rnd() > 0.95) o.couponCode = pick(["WINTER10", "WELCOME", "FREESHIP"]);
  orders.push(o);
}
d.orders.insertMany(orders);
d.orders.createIndex({ orderNo: 1 }, { unique: true });
d.orders.createIndex({ customerId: 1, createdAt: -1 });
d.orders.createIndex({ status: 1 }, { partialFilterExpression: { status: { $in: ["new", "paid"] } }, name: "open_status_partial" });
d.orders.createIndex({ notes: "text" }, { name: "notes_text" });
d.orders.createIndex({ "items.sku": 1 });
d.orders.createIndex({ customerId: "hashed" });
d.orders.createIndex({ currency: 1 }, { hidden: true, name: "currency_hidden" });

// ---- products: heterogeneous attributes (wildcard index), collation, Binary, mixed field types
d.createCollection("products", { collation: { locale: "sv", strength: 2 } });
const products = [];
for (let i = 1000; i < 1300; i++) {
  const cat = pick(categories);
  const p = { _id: `SKU-${i}`, name: `${pick(["Super", "Mega", "Eco", "Classic", "Pro"])} ${cat} item ${i}`, category: cat, price: NumberDecimal((int(49, 2999) + 0.95).toFixed(2)), inStock: int(0, 500), active: rnd() > 0.1, attributes: {} };
  if (cat === "shoes") p.attributes = { size: int(36, 46), color: pick(["black", "white", "red"]) };
  if (cat === "books") p.attributes = { isbn: `978-${int(1000000000, 9999999999)}`, pages: int(80, 900) };
  if (cat === "kitchen") p.attributes = { material: pick(["steel", "wood", "glass"]), dishwasherSafe: rnd() > 0.5 };
  if (rnd() > 0.9) p.thumbnail = BinData(0, "iVBORw0KGgo=");
  // weight is sometimes a number, sometimes a string: shows mixed types in Fields
  if (rnd() > 0.3) p.weight = rnd() > 0.5 ? int(100, 5000) : `${int(1, 5)} kg`;
  products.push(p);
}
d.products.insertMany(products);
d.products.createIndex({ "attributes.$**": 1 }, { name: "attributes_wildcard" });
d.products.createIndex({ name: 1 }, { collation: { locale: "sv", strength: 1 }, name: "name_sv_ci" });

// ---- stores: 2dsphere
d.stores.insertMany(cities.map((city, i) => ({ _id: i + 1, city, country: countries[city], location: { type: "Point", coordinates: [11 + i, 57 + i * 0.5] }, openingHours: { mon: "10-19", sat: "10-17", sun: rnd() > 0.5 ? "12-16" : null } })));
d.stores.createIndex({ location: "2dsphere" });

// ---- sessions: TTL index (10 years, so nothing expires)
d.sessions.insertMany(Array.from({ length: 50 }, (_, i) => ({ token: UUID(), customerId: int(1, 400), lastSeen: daysAgo(int(0, 30)), userAgent: pick(["Firefox", "Chrome", "Safari"]) })));
d.sessions.createIndex({ lastSeen: 1 }, { expireAfterSeconds: 315360000, name: "lastSeen_ttl" });

// ---- every BSON type in one place
d.bson_types.insertOne({
  _id: ObjectId("650000000000000000000001"),
  string: "text", int32: NumberInt(42), int64: NumberLong("9007199254740993"), double: 3.14159, decimal: NumberDecimal("12345.6789"),
  boolean: true, date: now, timestamp: Timestamp({ t: 1763121600, i: 1 }), null: null, regex: /^abc/i,
  objectId: ObjectId("650000000000000000000002"), uuid: UUID("5f1a0e9c-3b7d-4d7e-9a51-1c2b3d4e5f60"), binary: BinData(0, "SGVsbG8="),
  code: Code("function () { return 1; }"), minKey: MinKey(), maxKey: MaxKey(),
  array: [1, "two", { three: 3 }, [4]], emptyArray: [], emptyObject: {},
  nested: { level1: { level2: { level3: { value: "deep" } } } },
  "dotted.name": "a key with a dot", "$dollarPrefixed": "allowed since 5.0", "space key": "a key with a space", "unicodeÅÄÖ": "åäö"
});

// ---- events: query-operator validator (not $jsonSchema) with action warn
d.createCollection("events", {
  validator: { $and: [{ type: { $in: ["click", "view", "purchase"] } }, { at: { $type: "date" } }] },
  validationAction: "warn"
});
d.events.insertMany(Array.from({ length: 300 }, () => ({ type: pick(["click", "view", "view", "purchase"]), at: daysAgo(int(0, 30)), customerId: int(1, 400), page: pick(["/", "/shoes", "/kitchen", "/checkout"]) })));
d.events.insertOne({ type: "unknown", at: "not a date" }); // allowed (warn), shows a validation violation

// ---- legacy_users: $jsonSchema with validationLevel moderate
d.createCollection("legacy_users", {
  validator: { $jsonSchema: { bsonType: "object", required: ["username"], properties: { username: { bsonType: "string" } } } },
  validationLevel: "moderate"
});
d.legacy_users.insertMany([{ username: "old_admin", phone: "070-1234567" }, { username: "importer", phone: 46701234567 }, { username: "guest" }]);

// ---- strict_audit: errorAndLog (MongoDB 8.1+); skipped on older servers
try {
  d.createCollection("strict_audit", { validator: { $jsonSchema: { required: ["actor", "action"] } }, validationAction: "errorAndLog" });
  d.strict_audit.insertOne({ actor: "system", action: "seed" });
} catch (e) {
  print("strict_audit skipped: " + e.message);
}

// ---- capped collection
d.createCollection("audit_log", { capped: true, size: 1048576, max: 1000 });
d.audit_log.insertMany(Array.from({ length: 200 }, (_, i) => ({ seq: i, at: daysAgo(int(0, 10)), level: pick(["INFO", "INFO", "WARN", "ERROR"]), message: pick(["login", "logout", "export", "settings changed"]) })));

// ---- clustered collection
d.createCollection("clustered_events", { clusteredIndex: { key: { _id: 1 }, unique: true, name: "clustered_id" } });
d.clustered_events.insertMany(Array.from({ length: 100 }, (_, i) => ({ _id: daysAgo(100 - i), kind: pick(["a", "b", "c"]) })));

// ---- empty collection, and dotted names (one looks like GridFS but has no chunks, so it must not be grouped)
d.createCollection("empty_collection");
d.getCollection("reports.monthly").insertMany([{ month: "2026-09", revenue: NumberDecimal("1200000.00") }, { month: "2026-10", revenue: NumberDecimal("1350000.50") }]);
d.getCollection("orphan.files").insertOne({ filename: "not-really-gridfs.txt", note: "no orphan.chunks, so this is a plain collection" });

// ---- time series (two granularities; no expiry)
d.createCollection("sensor_readings", { timeseries: { timeField: "ts", metaField: "sensor", granularity: "minutes" } });
const readings = [];
for (let s = 1; s <= 5; s++) {
  for (let i = 0; i < 288; i++) {
    readings.push({ ts: new Date(now.getTime() - i * 5 * 60000), sensor: { id: `sensor-${s}`, site: pick(["warehouse", "store", "office"]) }, temperature: 18 + rnd() * 6, humidity: 30 + rnd() * 30 });
  }
}
d.sensor_readings.insertMany(readings);
d.createCollection("stock_ticks", { timeseries: { timeField: "at", granularity: "seconds" } });
d.stock_ticks.insertMany(Array.from({ length: 500 }, (_, i) => ({ at: new Date(now.getTime() - i * 1000), symbol: pick(["ABC", "XYZ"]), price: 100 + rnd() * 5 })));

// ---- GridFS: default "fs" bucket and a named "attachments" bucket
function gridfs(bucket, files) {
  files.forEach(({ filename, contentType, size }, i) => {
    const id = new ObjectId();
    const chunkSize = 261120;
    d.getCollection(`${bucket}.files`).insertOne({ _id: id, length: NumberLong(String(size)), chunkSize, uploadDate: daysAgo(i * 3), filename, metadata: { contentType, uploadedBy: pick(first) } });
    const n = Math.max(1, Math.ceil(size / chunkSize));
    for (let c = 0; c < Math.min(n, 3); c++) d.getCollection(`${bucket}.chunks`).insertOne({ files_id: id, n: c, data: BinData(0, "AAAA") });
  });
  d.getCollection(`${bucket}.chunks`).createIndex({ files_id: 1, n: 1 }, { unique: true });
  d.getCollection(`${bucket}.files`).createIndex({ filename: 1, uploadDate: 1 });
}
gridfs("fs", [{ filename: "logo.png", contentType: "image/png", size: 20480 }, { filename: "terms.pdf", contentType: "application/pdf", size: 600000 }]);
gridfs("attachments", [{ filename: "invoice-0001.pdf", contentType: "application/pdf", size: 81234 }, { filename: "photo.jpg", contentType: "image/jpeg", size: 900000 }, { filename: "notes.txt", contentType: "text/plain", size: 1200 }]);

// ---- views: simple filter, group, view on a view, $lookup
d.createView("open_orders", "orders", [{ $match: { status: { $in: ["new", "paid"] } } }]);
d.createView("revenue_by_status", "orders", [{ $group: { _id: "$status", orders: { $sum: 1 }, revenue: { $sum: "$total" } } }, { $sort: { revenue: -1 } }]);
d.createView("express_open_orders", "open_orders", [{ $match: { express: true } }, { $project: { orderNo: 1, customerId: 1, total: 1 } }]);
d.createView("orders_with_customer", "orders", [
  { $limit: 200 },
  { $lookup: { from: "customers", localField: "customerId", foreignField: "_id", as: "customer" } },
  { $unwind: "$customer" },
  { $project: { orderNo: 1, status: 1, total: 1, "customer.name": 1, "customer.address.city": 1 } }
]);

// ---- system.js
try {
  d.system.js.insertOne({ _id: "formatOrderNo", value: Code("function (n) { return 'ORD-' + String(n).padStart(6, '0'); }") });
} catch (e) {
  print("system.js skipped: " + e.message);
}

// ---- system.profile: profile everything in this database, then run some slow-ish queries
d.setProfilingLevel(2);
d.orders.find({ "shipping.method": "home", total: { $gt: NumberDecimal("1000") } }).sort({ createdAt: -1 }).toArray(); // COLLSCAN
d.orders.find({ customerId: 7 }).toArray(); // IXSCAN
d.orders.aggregate([{ $unwind: "$items" }, { $group: { _id: "$items.sku", qty: { $sum: "$items.qty" } } }, { $sort: { qty: -1 } }, { $limit: 10 }]).toArray();
d.customers.find({ "marketing.sms": true, tier: "gold" }).toArray();
d.orders.find({ $text: { $search: "gift" } }).toArray();
d.orders.countDocuments({ status: "returned" });
d.events.distinct("page");
d.orders.find({ $where: "this.items.length > 3" }).limit(20).toArray(); // deliberately slow
d.setProfilingLevel(1, { slowms: 100 }); // keep catching slow ops without logging everything

printjson(Object.fromEntries(d.getCollectionInfos().map((c) => [c.name, c.type])));
