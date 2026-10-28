// Shared storefront data (Firebase) and cart helpers.
// Products, categories, accounts and orders live in Firebase.
// The shopping cart stays in this browser's localStorage, as before.

const firebaseConfig = {
    apiKey: "AIzaSyCHAemBi71qB9diMJ9--_IlnCt2mzc3cV4",
    authDomain: "rk-main-c7124.firebaseapp.com",
    projectId: "rk-main-c7124",
    storageBucket: "rk-main-c7124.firebasestorage.app",
    messagingSenderId: "31301974162",
    appId: "1:31301974162:web:c5ef6cd84e3e7ff2928e4b"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// In-memory copy of the data, kept fresh by Firestore listeners.
const store = {
    products: [],
    categories: [],
    allOrders: [],      // admin only
    myOrders: [],       // signed-in customer's own orders
    recentOrders: {},   // orders placed in this session (guests can't read them back)
    user: null          // { uid, name, email, isAdmin }
};

let appReady = false;
let registering = false;
let syncCounter = 0;
let stopOrdersListener = () => {};

// Remove data the old localStorage version left behind (it held passwords in plain text).
['products', 'categories', 'users', 'allOrders', 'currentUser'].forEach(key => localStorage.removeItem(key));
Object.keys(localStorage)
    .filter(key => key.startsWith('orders_'))
    .forEach(key => localStorage.removeItem(key));

document.addEventListener('DOMContentLoaded', () => {
    updateCartCount();
});

// ---------- Data access ----------
function getProducts() { return store.products; }
function getSavedCategories() { return store.categories; }
function getCurrentUser() { return store.user; }
function getAllOrders() { return store.allOrders; }
function getMyOrders() { return store.myOrders; }

function getOrderById(id) {
    return store.recentOrders[id]
        || store.allOrders.find(order => order.id === id)
        || store.myOrders.find(order => order.id === id);
}

function rememberOrder(order) {
    store.recentOrders[order.id] = order;
}

// ---------- Firestore listeners ----------
function listen(query, onData) {
    let unsubscribe = () => {};
    const ready = new Promise(resolve => {
        let first = true;
        unsubscribe = query.onSnapshot(
            snapshot => {
                onData(snapshot);
                if (first) {
                    first = false;
                    resolve();
                } else if (appReady && typeof refreshView === 'function') {
                    refreshView();
                }
            },
            error => {
                console.error('Firestore listener error:', error);
                if (first) {
                    first = false;
                    resolve();
                }
            }
        );
    });
    return { ready, unsubscribe: () => unsubscribe() };
}

const productsListener = listen(db.collection('products'), snapshot => {
    store.products = snapshot.docs
        .map(doc => doc.data())
        .sort((a, b) => Number(a.id) - Number(b.id));
});

const categoriesListener = listen(db.doc('meta/categories'), snapshot => {
    store.categories = snapshot.exists && Array.isArray(snapshot.data().list) ? snapshot.data().list : [];
});

// ---------- Auth ----------
async function syncUser(fbUser) {
    const token = ++syncCounter;
    stopOrdersListener();
    stopOrdersListener = () => {};
    store.allOrders = [];
    store.myOrders = [];

    if (!fbUser) {
        store.user = null;
        return;
    }

    let profile = {};
    try {
        const snapshot = await db.collection('users').doc(fbUser.uid).get();
        if (snapshot.exists) {
            profile = snapshot.data();
        } else {
            profile = {
                name: fbUser.displayName || (fbUser.email || '').split('@')[0],
                email: fbUser.email || '',
                isAdmin: false
            };
            db.collection('users').doc(fbUser.uid).set(profile).catch(error => console.error('Profile create failed:', error));
        }
    } catch (error) {
        console.error('Could not load the account profile:', error);
    }
    if (token !== syncCounter) return;

    store.user = {
        uid: fbUser.uid,
        name: profile.name || '',
        email: profile.email || fbUser.email || '',
        isAdmin: profile.isAdmin === true
    };

    const query = store.user.isAdmin
        ? db.collection('orders').orderBy('createdAtMs')
        : db.collection('orders').where('uid', '==', fbUser.uid);
    const ordersListener = listen(query, snapshot => {
        const orders = snapshot.docs.map(doc => doc.data()).sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
        if (store.user?.isAdmin) store.allOrders = orders;
        else store.myOrders = orders;
    });
    stopOrdersListener = ordersListener.unsubscribe;
    await ordersListener.ready;
}

const authReady = new Promise(resolve => {
    auth.onAuthStateChanged(async fbUser => {
        if (registering) return; // handleRegister signs the new account out itself
        await syncUser(fbUser);
        resolve();
        if (appReady && typeof renderPage === 'function') renderPage();
    });
});

// Resolves once the first page can be drawn (or after 10 s, so the site never hangs on a blank screen).
const dataReady = Promise.race([
    Promise.all([productsListener.ready, categoriesListener.ready, authReady]),
    new Promise(resolve => setTimeout(() => {
        console.warn('Firebase is slow to respond; showing the shop with what has loaded.');
        resolve();
    }, 10000))
]);

function waitForUser(uid, timeout = 8000) {
    return new Promise(resolve => {
        const started = Date.now();
        (function check() {
            if (store.user?.uid === uid || Date.now() - started > timeout) resolve(store.user);
            else setTimeout(check, 50);
        })();
    });
}

function logout() {
    store.user = null;
    store.allOrders = [];
    store.myOrders = [];
    stopOrdersListener();
    stopOrdersListener = () => {};
    auth.signOut().catch(error => console.error('Sign out failed:', error));
    window.location.hash = '#/home';
}

// ---------- Cart ----------
function getCart() {
    try {
        return JSON.parse(localStorage.getItem('cart')) || [];
    } catch (error) {
        return [];
    }
}

function saveCart(cart) {
    localStorage.setItem('cart', JSON.stringify(cart));
    updateCartCount();
}

function addToCart(productId, quantity = 1, options = {}) {
    const product = getProducts().find(p => Number(p.id) === Number(productId));
    if (!product) return false;

    const safeQuantity = Math.max(1, Number.parseInt(quantity, 10) || 1);
    const selectedOptions = Object.fromEntries(
        Object.entries(options).sort(([first], [second]) => first.localeCompare(second))
    );
    const optionsKey = JSON.stringify(selectedOptions);
    const cart = getCart();
    const existingItem = cart.find(item =>
        Number(item.id) === Number(productId) &&
        JSON.stringify(Object.fromEntries(
            Object.entries(item.options || {}).sort(([first], [second]) => first.localeCompare(second))
        )) === optionsKey
    );

    if (existingItem) {
        existingItem.quantity = Number(existingItem.quantity) + safeQuantity;
    } else {
        cart.push({ ...product, options: selectedOptions, quantity: safeQuantity });
    }

    saveCart(cart);
    return true;
}

function updateCartCount() {
    const cart = getCart();
    const count = cart.reduce((total, item) => total + item.quantity, 0);
    const cartCountElement = document.getElementById('cart-count');
    if (cartCountElement) {
        cartCountElement.innerText = count;
    }
}
