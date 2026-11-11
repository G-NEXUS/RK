const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = Number(process.env.PORT || 10000);
const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'rk_connekt';
const client = mongoUri ? new MongoClient(mongoUri) : null;
let db;
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined
}) : null;
app.use(express.json({ limit: '12mb' }));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

function requireConfig() {
    if (!mongoUri) throw new Error('MONGODB_URI is required.');
}
function publicUser(user) {
    return { uid: user.uid || user.firebaseUid, name: user.name || '', email: user.email || '', isAdmin: user.isAdmin === true };
}
function hashSession(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function newId(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }
async function createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.collection('sessions').insertOne({ tokenHash: hashSession(token), uid: user.uid || user.firebaseUid, createdAtMs: Date.now(), expiresAtMs: Date.now() + 1000 * 60 * 60 * 24 * 30 });
    return token;
}
async function auth(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    try {
        const session = await db.collection('sessions').findOne({ tokenHash: hashSession(token), expiresAtMs: { $gt: Date.now() } });
        if (!session) return res.status(401).json({ error: 'Authentication required.', code: 'auth/session-expired' });
        req.authUid = session.uid;
        req.authUser = await db.collection('users').findOne({ $or: [{ uid: req.authUid }, { firebaseUid: req.authUid }] });
        if (!req.authUser) return res.status(401).json({ error: 'Account not found.', code: 'auth/account-not-found' });
        next();
    } catch {
        res.status(401).json({ error: 'Authentication required.' });
    }
}

async function currentUser(req) {
    return req.authUser || db.collection('users').findOne({ $or: [{ uid: req.authUid }, { firebaseUid: req.authUid }] });
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
    const session = await db.collection('sessions').findOne({ tokenHash: hashSession(token), expiresAtMs: { $gt: Date.now() } });
    const user = session ? await db.collection('users').findOne({ $or: [{ uid: session.uid }, { firebaseUid: session.uid }] }) : null;
    res.json({ user: user ? publicUser(user) : null });
});

app.post('/api/auth/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await db.collection('users').findOne({ email });
    if (!user) return res.status(401).json({ code: 'auth/user-not-found', error: 'No account was found for this email address.' });
    if (!user.passwordHash) return res.status(401).json({ code: 'auth/password-reset-required', error: 'This account needs a password reset before it can be used.' });
    if (!(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ code: 'auth/invalid-credential' });
    const token = await createSession(user);
    res.json({ user: publicUser(user), token });
});

app.post('/api/auth/register', async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name) return res.status(400).json({ code: 'auth/missing-name', error: 'Full name is required.' });
    if (!email || !email.includes('@')) return res.status(400).json({ code: 'auth/invalid-email', error: 'A valid email address is required.' });
    if (password.length < 6) return res.status(400).json({ code: 'auth/weak-password' });
    if (await db.collection('users').findOne({ email })) return res.status(409).json({ code: 'auth/email-already-in-use', error: 'An account already exists for this email.' });
    const user = { uid: newId('usr'), name, email, passwordHash: await bcrypt.hash(password, 12), authProvider: 'mongodb', isAdmin: false, createdAtMs: Date.now() };
    await db.collection('users').insertOne(user);
    res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/logout', auth, async (req, res) => {
    const token = (req.get('authorization') || '').slice(7);
    await db.collection('sessions').deleteOne({ tokenHash: hashSession(token) });
    res.json({ ok: true });
});

app.post('/api/auth/forgot-password', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = await db.collection('users').findOne({ email });
    if (user) {
        const rawToken = crypto.randomBytes(32).toString('hex');
        await db.collection('passwordResets').insertOne({ tokenHash: hashSession(rawToken), uid: user.uid || user.firebaseUid, expiresAtMs: Date.now() + 1000 * 60 * 30, used: false });
        const resetUrl = `${process.env.PUBLIC_APP_URL || ''}/#/reset-password?token=${rawToken}`;
        if (mailer && process.env.RESET_FROM_EMAIL) {
            await mailer.sendMail({ from: process.env.RESET_FROM_EMAIL, to: email, subject: 'Reset your RK CONNEKT password', text: `Use this link within 30 minutes to choose a new password: ${resetUrl}`, html: `<p>Use this link within 30 minutes to choose a new password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>` });
        } else {
            console.warn(`SMTP is not configured. Password reset link for ${email}: ${resetUrl}`);
        }
    }
    res.json({ ok: true, message: 'If an account exists for this email, a password reset link has been created.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    if (password.length < 6) return res.status(400).json({ code: 'auth/weak-password', error: 'Password must be at least 6 characters.' });
    const reset = await db.collection('passwordResets').findOne({ tokenHash: hashSession(token), expiresAtMs: { $gt: Date.now() }, used: false });
    if (!reset) return res.status(400).json({ code: 'auth/invalid-reset-token', error: 'This reset link is invalid or has expired. Request a new one.' });
    await db.collection('users').updateOne({ $or: [{ uid: reset.uid }, { firebaseUid: reset.uid }] }, { $set: { passwordHash: await bcrypt.hash(password, 12), authProvider: 'mongodb', passwordUpdatedAtMs: Date.now() } });
    await db.collection('passwordResets').updateOne({ _id: reset._id }, { $set: { used: true, usedAtMs: Date.now() } });
    await db.collection('sessions').deleteMany({ uid: reset.uid });
    res.json({ ok: true });
});

app.patch('/api/profile', auth, async (req, res) => {
    const name = String(req.body.name || '').trim();
    await db.collection('users').updateOne({ $or: [{ uid: req.authUid }, { firebaseUid: req.authUid }] }, { $set: { name } });
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
    res.json({ user: user ? publicUser(user) : null });
});
app.patch('/api/users/me', auth, async (req, res) => {
    await db.collection('users').updateOne({ $or: [{ uid: req.authUid }, { firebaseUid: req.authUid }] }, { $set: { name: String(req.body.name || '').trim() } });
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
    const filter = user?.isAdmin ? { id: req.params.id } : { id: req.params.id, uid: req.authUid };
    const existing = await db.collection('orders').findOne(filter);
    if (!existing) return res.status(404).json({ error: 'Order not found.' });
    await db.collection('orders').updateOne(filter, { $set: req.body });
    res.json({ ok: true });
});
app.post('/api/orders', auth, async (req, res) => {
    const user = (await currentUser(req)) || { name: '', email: '' };
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
    await db.collection('users').updateMany({ firebaseUid: { $exists: true }, uid: { $exists: false } }, [{ $set: { uid: '$firebaseUid', authProvider: 'mongodb-reset-required' } }]);
    await db.collection('users').createIndex({ uid: 1 }, { unique: true, sparse: true });
    await db.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
    await db.collection('sessions').createIndex({ expiresAtMs: 1 }, { expireAfterSeconds: 0 });
    await db.collection('passwordResets').createIndex({ expiresAtMs: 1 }, { expireAfterSeconds: 0 });
    if (process.env.MIGRATE_CATALOG_FROM_FIRESTORE === 'true') await migrateCatalogFromFirestore();
    await db.collection('products').createIndex({ id: 1 }, { unique: true });
    await db.collection('orders').createIndex({ id: 1, uid: 1 }, { unique: true });
    app.listen(port, '0.0.0.0', () => console.log(`RK CONNEKT listening on ${port}`));
}

function firestoreValue(value) {
    if (!value || typeof value !== 'object') return value;
    if ('stringValue' in value) return value.stringValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('doubleValue' in value) return Number(value.doubleValue);
    if ('booleanValue' in value) return value.booleanValue;
    if ('timestampValue' in value) return value.timestampValue;
    if ('nullValue' in value) return null;
    if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreValue);
    if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, firestoreValue(item)]));
    return value;
}

async function firestoreDocument(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Firestore import request failed with HTTP ${response.status}`);
    return response.json();
}

async function migrateCatalogFromFirestore() {
    const base = 'https://firestore.googleapis.com/v1/projects/rk-main-c7124/databases/(default)/documents';
    const [productsDoc, categoriesDoc] = await Promise.all([
        firestoreDocument(`${base}/products`),
        firestoreDocument(`${base}/meta/categories`)
    ]);
    const products = (productsDoc.documents || []).map(document => ({
        ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, firestoreValue(value)])),
        id: Number(firestoreValue(document.fields?.id) || document.name.split('/').pop())
    }));
    for (const product of products) await db.collection('products').replaceOne({ id: product.id }, product, { upsert: true });
    const categoryData = Object.fromEntries(Object.entries(categoriesDoc.fields || {}).map(([key, value]) => [key, firestoreValue(value)]));
    const variantCategories = categoryData.variantCategories || [];
    await db.collection('meta').updateOne({ key: 'categories' }, { $set: { key: 'categories', list: categoryData.list || [], sizeCategories: categoryData.sizeCategories || variantCategories, colorCategories: categoryData.colorCategories || variantCategories } }, { upsert: true });
    console.log(`Catalog migration complete: ${products.length} products and ${(categoryData.list || []).length} categories.`);
}

start().catch(error => { console.error(error); process.exit(1); });
