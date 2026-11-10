const path = require('path');
const crypto = require('crypto');
const express = require('express');
const firebaseAdmin = require('firebase-admin');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = Number(process.env.PORT || 10000);
const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'rk_connekt';
function loadFirebaseServiceAccount() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain the raw Firebase service-account JSON, not JavaScript such as var admin = require("firebase-admin").');
    }
}
const firebaseServiceAccount = loadFirebaseServiceAccount();
const client = mongoUri ? new MongoClient(mongoUri) : null;
let db;
if (firebaseServiceAccount) firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(firebaseServiceAccount) });

app.use(express.json({ limit: '12mb' }));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

function requireConfig() {
    if (!mongoUri || !firebaseServiceAccount) throw new Error('MONGODB_URI and FIREBASE_SERVICE_ACCOUNT_JSON are required.');
}

function publicUser(user) {
    return { uid: user.firebaseUid, name: user.name || '', email: user.email, isAdmin: user.isAdmin === true };
}

async function auth(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    try {
        req.firebaseUser = await firebaseAdmin.auth().verifyIdToken(token);
        req.authUid = req.firebaseUser.uid;
        next();
    } catch {
        res.status(401).json({ error: 'Authentication required.' });
    }
}

async function currentUser(req) {
    return db.collection('users').findOne({ firebaseUid: req.authUid });
}

async function admin(req, res, next) {
    const user = await currentUser(req);
    if (!user?.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
    req.user = user;
    next();
}

function cleanProduct(body, existing = {}) {
    const product = {
        ...existing,
        id: Number(body.id ?? existing.id),
        name: String(body.name ?? '').trim(),
        price: Number(body.price),
        image: String(body.image ?? ''),
        gallery: Array.isArray(body.gallery) ? body.gallery.map(String).slice(0, 6) : [],
        category: String(body.category ?? '').trim(),
        description: String(body.description ?? '').trim()
    };
    if (!product.id || !product.name || !Number.isFinite(product.price) || product.price < 0 || !product.image || !product.category) {
        throw new Error('Product fields are invalid.');
    }
    if (body.bulkPrice !== undefined && body.bulkMinQty !== undefined) {
        const bulkPrice = Number(body.bulkPrice);
        const bulkMinQty = Number(body.bulkMinQty);
        if (!Number.isFinite(bulkPrice) || bulkPrice < 0 || bulkPrice >= product.price || !Number.isInteger(bulkMinQty) || bulkMinQty < 2) {
            throw new Error('Bulk pricing is invalid.');
        }
        product.bulkPrice = bulkPrice;
        product.bulkMinQty = bulkMinQty;
    } else {
        delete product.bulkPrice;
        delete product.bulkMinQty;
    }
    if (body.options && typeof body.options === 'object') product.options = body.options;
    else delete product.options;
    return product;
}

function plain(doc) {
    if (!doc) return null;
    const { _id, ...value } = doc;
    return value;
}

function makeSnapshot(docs) {
    return docs.map(doc => plain(doc));
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/auth/me', async (req, res) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.json({ user: null });
    try {
        const firebaseUser = await firebaseAdmin.auth().verifyIdToken(token);
        const user = await db.collection('users').findOne({ firebaseUid: firebaseUser.uid });
        res.json({ user: user ? publicUser(user) : { uid: firebaseUser.uid, name: firebaseUser.name || '', email: firebaseUser.email || '', isAdmin: false } });
    } catch {
        res.json({ user: null });
    }
});

app.post('/api/auth/forgot-password', (req, res) => res.json({ ok: true }));

app.patch('/api/profile', auth, async (req, res) => {
    const name = String(req.body.name || '').trim();
    await db.collection('users').updateOne({ firebaseUid: req.authUid }, { $set: { name }, $setOnInsert: { firebaseUid: req.authUid, email: req.firebaseUser.email || '', isAdmin: false, createdAtMs: Date.now() } }, { upsert: true });
    const user = await currentUser(req);
    res.json({ user: publicUser(user) });
});

app.get('/api/products', async (req, res) => {
    const products = await db.collection('products').find({}).sort({ id: 1 }).toArray();
    res.json({ products: makeSnapshot(products) });
});
app.put('/api/admin/products/:id', auth, admin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const existing = await db.collection('products').findOne({ id });
        const product = cleanProduct({ ...req.body, id }, existing || {});
        await db.collection('products').replaceOne({ id }, product, { upsert: true });
        res.json({ product });
    } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/admin/products/:id', auth, admin, async (req, res) => {
    await db.collection('products').deleteOne({ id: Number(req.params.id) });
    res.json({ ok: true });
});

app.get('/api/categories', async (req, res) => {
    const doc = await db.collection('meta').findOne({ key: 'categories' });
    res.json({ categories: doc?.list || [], sizeCategories: doc?.sizeCategories || doc?.variantCategories || [], colorCategories: doc?.colorCategories || doc?.variantCategories || [] });
});
app.put('/api/admin/categories', auth, admin, async (req, res) => {
    const categories = Array.isArray(req.body.list) ? req.body.list.map(String) : [];
    const sizeCategories = Array.isArray(req.body.sizeCategories) ? req.body.sizeCategories.map(String).filter(x => categories.includes(x)) : [];
    const colorCategories = Array.isArray(req.body.colorCategories) ? req.body.colorCategories.map(String).filter(x => categories.includes(x)) : [];
    await db.collection('meta').updateOne({ key: 'categories' }, { $set: { key: 'categories', list: categories, sizeCategories, colorCategories } }, { upsert: true });
    res.json({ categories, sizeCategories, colorCategories });
});

app.get('/api/users/me', auth, async (req, res) => {
    const user = await currentUser(req);
    res.json({ user: user ? publicUser(user) : { uid: req.authUid, name: req.firebaseUser.name || '', email: req.firebaseUser.email || '', isAdmin: false } });
});
app.patch('/api/users/me', auth, async (req, res) => {
    await db.collection('users').updateOne({ firebaseUid: req.authUid }, { $set: { name: String(req.body.name || '').trim(), email: req.firebaseUser.email || '' }, $setOnInsert: { firebaseUid: req.authUid, isAdmin: false, createdAtMs: Date.now() } }, { upsert: true });
    res.json({ ok: true });
});

app.get('/api/orders', auth, async (req, res) => {
    const user = await currentUser(req);
    const filter = user?.isAdmin ? {} : { uid: req.authUid };
    const orders = await db.collection('orders').find(filter).sort({ createdAtMs: 1 }).toArray();
    res.json({ orders: makeSnapshot(orders) });
});
app.put('/api/orders/:id', auth, async (req, res) => {
    const user = await currentUser(req);
    const filter = user?.isAdmin ? { id: req.params.id } : { id: req.params.id, uid: req.authId.toString() };
    const existing = await db.collection('orders').findOne(filter);
    if (!existing) return res.status(404).json({ error: 'Order not found.' });
    await db.collection('orders').updateOne(filter, { $set: req.body });
    res.json({ ok: true });
});
app.post('/api/orders', auth, async (req, res) => {
    const user = (await currentUser(req)) || { name: req.firebaseUser.name || '', email: req.firebaseUser.email || '' };
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const products = await db.collection('products').find({ id: { $in: items.map(item => Number(item.id)) } }).toArray();
    const byId = new Map(products.map(product => [Number(product.id), product]));
    const cleanItems = items.map(item => {
        const product = byId.get(Number(item.id));
        const quantity = Math.max(1, Number.parseInt(item.quantity, 10) || 1);
        if (!product) throw new Error('A product is no longer available.');
        const totalSameProduct = items.filter(other => Number(other.id) === Number(item.id)).reduce((sum, other) => sum + (Number(other.quantity) || 0), 0);
        const bulk = product.bulkPrice !== undefined && product.bulkMinQty !== undefined && totalSameProduct >= Number(product.bulkMinQty);
        return { id: Number(product.id), name: product.name, price: bulk ? Number(product.bulkPrice) : Number(product.price), quantity, options: item.options || {} };
    });
    const total = cleanItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const order = { ...req.body, id: String(req.body.id || `ORD-${Date.now()}`), uid: req.authUid, customer: user.name || 'WhatsApp customer', email: user.email, items: cleanItems, total, createdAtMs: Date.now() };
    await db.collection('orders').updateOne({ id: order.id, uid: order.uid }, { $setOnInsert: order }, { upsert: true });
    res.status(201).json({ order });
});

app.get('/api/messages', auth, admin, async (req, res) => {
    const messages = await db.collection('messages').find({}).sort({ createdAtMs: 1 }).toArray();
    res.json({ messages: makeSnapshot(messages) });
});
app.post('/api/messages', async (req, res) => {
    const message = { id: `MSG-${Date.now()}`, name: String(req.body.name || '').trim(), email: String(req.body.email || '').trim(), subject: String(req.body.subject || '').trim(), message: String(req.body.message || '').trim(), createdAtMs: Date.now(), read: false };
    if (!message.name || !message.email || !message.subject || !message.message) return res.status(400).json({ error: 'All contact fields are required.' });
    await db.collection('messages').insertOne(message);
    res.status(201).json({ message });
});
app.patch('/api/messages/:id', auth, admin, async (req, res) => { await db.collection('messages').updateOne({ id: req.params.id }, { $set: { read: Boolean(req.body.read) } }); res.json({ ok: true }); });
app.delete('/api/messages/:id', auth, admin, async (req, res) => { await db.collection('messages').deleteOne({ id: req.params.id }); res.json({ ok: true }); });

app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    requireConfig();
    await client.connect();
    db = client.db(dbName);
    await db.collection('users').createIndex({ firebaseUid: 1 }, { unique: true });
    await db.collection('products').createIndex({ id: 1 }, { unique: true });
    await db.collection('orders').createIndex({ id: 1, uid: 1 }, { unique: true });
    await migrateFromFirestore();
    app.listen(port, '0.0.0.0', () => console.log(`RK CONNEKT listening on ${port}`));
}

async function migrateFromFirestore() {
    if (process.env.MIGRATE_FROM_FIRESTORE !== 'true') return;
    const existingProducts = await db.collection('products').countDocuments();
    if (existingProducts > 0) {
        console.log('MongoDB already contains products; skipping Firebase migration.');
        return;
    }
    const firestore = firebaseAdmin.firestore();
    const [products, categories, users, orders, messages] = await Promise.all([
        firestore.collection('products').get(),
        firestore.doc('meta/categories').get(),
        firestore.collection('users').get(),
        firestore.collection('orders').get(),
        firestore.collection('messages').get()
    ]);
    if (!products.empty) {
        await db.collection('products').insertMany(products.docs.map(doc => ({ ...doc.data(), id: Number(doc.data().id || doc.id) })), { ordered: false });
    }
    if (categories.exists) {
        const data = categories.data() || {};
        const variantCategories = data.variantCategories || [];
        await db.collection('meta').updateOne({ key: 'categories' }, { $set: { key: 'categories', list: data.list || [], sizeCategories: data.sizeCategories || variantCategories, colorCategories: data.colorCategories || variantCategories } }, { upsert: true });
    }
    if (!users.empty) {
        await Promise.all(users.docs.map(doc => {
            const data = doc.data() || {};
            return db.collection('users').updateOne({ firebaseUid: doc.id }, { $set: { ...data, firebaseUid: doc.id, email: data.email || '' } }, { upsert: true });
        }));
    }
    for (const [collection, snapshot] of [['orders', orders], ['messages', messages]]) {
        await Promise.all(snapshot.docs.map(doc => {
            const data = doc.data() || {};
            const id = String(data.id || doc.id);
            return db.collection(collection).updateOne({ id }, { $set: { ...data, id } }, { upsert: true });
        }));
    }
    console.log(`Firebase migration complete: ${products.size} products, ${users.size} users, ${orders.size} orders, ${messages.size} messages.`);
}

start().catch(error => { console.error(error); process.exit(1); });
