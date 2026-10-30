// Shared storefront data (Firebase) and cart helpers.
// Products, categories, accounts and orders live in Firebase.
// The shopping cart stays in this browser's localStorage, as before.

// Import the hidden config object at the very top
import firebaseConfig from './config.js';

// Initialize Firebase using the imported config
firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();


// In-memory copy of the data, kept fresh by Firestore listeners.
const store = {
    products: [],
    categories: [],
    variantCategories: [],   // categories whose products need size & color
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
function getVariantCategories() { return store.variantCategories; }
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
    const data = snapshot.exists ? snapshot.data() : {};
    store.categories = Array.isArray(data.list) ? data.list : [];
    store.variantCategories = Array.isArray(data.variantCategories) ? data.variantCategories : [];
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
        // The extra gallery photos stay out of the cart so it remains small.
        const { gallery, ...cartProduct } = product;
        cart.push({ ...cartProduct, options: selectedOptions, quantity: safeQuantity });
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
    if (typeof syncCartButtons === 'function') syncCartButtons();
}


// =====================================================================
// Page rendering, routing and actions (previously inline in index.html)
// =====================================================================

const app = document.getElementById('app');
const brand = 'RK General Dealers';
let lastAdminTab = 'overview';
let lastDashboardTab = 'profile';
const currency = new Intl.NumberFormat('en-ZM', { maximumFractionDigits: 2 });

function formatMoney(value) {
    return `K${currency.format(Number(value) || 0)}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function routeInfo() {
    const [path = '/home', query = ''] = location.hash.slice(1).split('?');
    return { page: path.replace(/^\/+/, '') || 'home', params: new URLSearchParams(query) };
}

function passwordField(id, label) {
    return `<div class="form-group">
        <label for="${id}">${label}</label>
        <div class="password-field">
            <input type="password" id="${id}" required autocomplete="${id === 'login-password' ? 'current-password' : 'new-password'}">
            <button class="password-toggle" type="button" aria-label="Show ${label.toLowerCase()}" aria-pressed="false" onclick="togglePassword('${id}', this)">
                <svg class="icon-eye" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                <svg class="icon-eye-off" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a15.8 15.8 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7c1 0 2-.2 2.9-.5"/></svg>
            </button>
        </div>
    </div>`;
}

function togglePassword(id, button) {
    const input = document.getElementById(id);
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(visible));
    const fieldName = id === 'card-cvv' ? 'security code' : id.includes('confirm') ? 'confirm password' : 'password';
    button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${fieldName}`);
}

function toggleMenu(forceClose = false) {
    const menu = document.getElementById('primary-navigation');
    const button = document.getElementById('menu-toggle');
    const isOpen = !forceClose && !menu.classList.contains('is-open');
    menu.classList.toggle('is-open', isOpen);
    button.setAttribute('aria-expanded', String(isOpen));
    button.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
}

function closeAuthForm() {
    location.hash = '#/home';
}

function authForm(content) {
    return `<section class="auth-stage"><div class="form-container auth-form">
        <button class="auth-close" type="button" aria-label="Close form" onclick="closeAuthForm()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
        </button>${content}
    </div></section>`;
}

function hasOptions(product) {
    return !!product.options && typeof product.options === 'object'
        && Object.values(product.options).some(values => Array.isArray(values) && values.length);
}

function getProductPhotos(product) {
    return [product.image, ...(Array.isArray(product.gallery) ? product.gallery : [])].filter(Boolean);
}

function cartSummaryMarkup(productId) {
    const lines = getCart().filter(item => Number(item.id) === Number(productId));
    if (!lines.length) return '';
    return `<p class="cart-summary-title">In your cart</p>
        <ul class="cart-summary-list">${lines.map(item => {
            const details = Object.entries(item.options || {}).map(([name, value]) => `${name}: ${value}`).join(', ');
            return `<li>${Number(item.quantity)} × ${escapeHtml(details || item.name)}</li>`;
        }).join('')}</ul>
        <a href="#/cart" class="btn btn-outline btn-small">View Cart</a>`;
}

function productCard(product) {
    const needsOptions = hasOptions(product);
    const inCart = isInCart(product.id);
    const idleText = needsOptions ? 'Select Options' : 'Add to Cart';
    return `<article class="product-card">
        <div class="product-image"><a href="#/product?id=${encodeURIComponent(product.id)}"><img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}"></a></div>
        <div class="product-info">
            <div><h3 class="product-title">${escapeHtml(product.name)}</h3><p class="product-price">${formatMoney(product.price)}</p></div>
            <button class="btn btn-full${inCart ? ' is-added' : ''}" data-cart-id="${Number(product.id)}" data-original-text="${idleText}" onclick="addToCartFromButton(${Number(product.id)})">${inCart ? 'Added to Cart ✓' : idleText}</button>
        </div>
    </article>`;
}

function renderProductOptions(product) {
    if (!product.options || typeof product.options !== 'object') return '';
    return Object.entries(product.options).map(([name, values], index) => {
        if (!Array.isArray(values) || !values.length) return '';
        const id = `product-option-${index}`;
        return `<div class="form-group product-option">
            <label for="${id}">${escapeHtml(name)}</label>
            <select id="${id}" data-option-name="${escapeHtml(name)}">
                <option value="" selected disabled>Select ${escapeHtml(name.toLowerCase())}</option>
                ${values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}
            </select>
        </div>`;
    }).join('');
}

function renderHome() {
    const products = getProducts();
    app.innerHTML = `<header class="hero">
        <div class="hero-content">
            <p class="eyebrow">Good finds. Everyday value.</p>
            <p>Shop dependable essentials for work, home, and everywhere in between.</p>
        </div>
    </header>
    <div class="sticky-search-wrap">
        <form class="search-form" onsubmit="searchProducts(event)">
            <input type="search" id="search-input" placeholder="Search products..." aria-label="Search products">
            <button class="btn" type="submit">Search</button>
        </form>
    </div>
    <section class="shop-section">
        <h2 class="section-title">Our Products</h2>
        <div class="product-grid">${products.length ? products.map(productCard).join('') : '<p>No products available yet.</p>'}</div>
    </section>`;
}

function renderSearch() {
    const query = routeInfo().params.get('q') || '';
    const normalizedQuery = query.toLowerCase();
    const products = getProducts();
    const matches = products.filter(product => [product.name, product.category, product.description]
        .some(value => String(value || '').toLowerCase().includes(normalizedQuery)));
    app.innerHTML = `<h1 class="section-title mt-20">Search results for "${escapeHtml(query)}"</h1>
        <div class="product-grid">${matches.map(productCard).join('')}</div>
        ${matches.length ? '' : '<div class="text-center empty-state"><h2>No products found matching your search.</h2><a href="#/home" class="btn mt-20">View All Products</a></div>'}`;
}

function showProductPhoto(index) {
    const thumbs = [...document.querySelectorAll('.gallery-thumb')];
    const main = document.getElementById('detail-main-image');
    const target = thumbs[index]?.querySelector('img');
    if (!main || !target) return;
    main.src = target.src;
    thumbs.forEach((thumb, position) => {
        thumb.classList.toggle('is-active', position === index);
        thumb.setAttribute('aria-current', String(position === index));
    });
}

function renderProduct() {
    const id = routeInfo().params.get('id');
    const product = getProducts().find(item => String(item.id) === id);
    if (!product) {
        app.innerHTML = '<div class="empty-state"><h1>Product not found.</h1><a class="btn mt-20" href="#/home">Back to shop</a></div>';
        return;
    }
    document.title = `${product.name} | ${brand}`;
    const photos = getProductPhotos(product);
    const productId = Number(product.id);
    const inCart = isInCart(productId);
    app.innerHTML = `<div class="product-detail-container">
        <div class="detail-image">
            <img id="detail-main-image" src="${escapeHtml(photos[0] || '')}" alt="${escapeHtml(product.name)}">
            ${photos.length > 1 ? `<div class="gallery-thumbs">${photos.map((src, index) => `<button type="button" class="gallery-thumb${index === 0 ? ' is-active' : ''}" aria-label="Show photo ${index + 1} of ${photos.length}" onclick="showProductPhoto(${index})"><img src="${escapeHtml(src)}" alt=""></button>`).join('')}</div>` : ''}
        </div>
        <div class="detail-info">
            <p class="eyebrow">${escapeHtml(product.category)}</p>
            <h1>${escapeHtml(product.name)}</h1>
            <p class="detail-price">${formatMoney(product.price)}</p>
            <p class="detail-desc">${escapeHtml(product.description || 'No description available.')}</p>
            <div class="product-options">${renderProductOptions(product)}</div>
            <div class="detail-actions"><label for="product-qty">Quantity</label><input type="number" id="product-qty" value="1" min="1"><button class="btn${inCart ? ' is-added' : ''}" data-cart-id="${productId}" data-original-text="Add to Cart" onclick="addProductQuantity(${productId})">${inCart ? 'Added to Cart ✓' : 'Add to Cart'}</button><button class="btn btn-outline whatsapp-order-button" onclick="orderProductViaWhatsApp(${productId})">Order via WhatsApp</button></div>
            <div id="product-cart-summary" class="product-cart-summary" data-product-id="${productId}">${cartSummaryMarkup(productId)}</div>
        </div>
    </div>`;
}

function renderLogin() {
    app.innerHTML = authForm(`<h1 class="text-center mb-20">Welcome Back</h1>
        <form onsubmit="handleLogin(event)">
            <div class="form-group"><label for="login-email">Email Address</label><input type="email" id="login-email" autocomplete="email" required></div>
            ${passwordField('login-password', 'Password')}
            <p class="text-center mb-20"><a class="text-accent" href="#/forgot-password">Forgot Password?</a></p>
            <button type="submit" class="btn btn-full">Login</button>
        </form>
        <p class="text-center mt-20">Don't have an account? <a class="text-accent" href="#/register">Register here</a></p>`);
}

function renderRegister() {
    app.innerHTML = authForm(`<h1 class="text-center mb-20">Create Account</h1>
        <form onsubmit="handleRegister(event)">
            <div class="form-group"><label for="reg-name">Full Name</label><input type="text" id="reg-name" autocomplete="name" required></div>
            <div class="form-group"><label for="reg-email">Email Address</label><input type="email" id="reg-email" autocomplete="email" required></div>
            ${passwordField('reg-password', 'Password')}
            <button type="submit" class="btn btn-full">Register</button>
        </form>
        <p class="text-center mt-20">Already have an account? <a class="text-accent" href="#/login">Login here</a></p>`);
}

function renderForgotPassword() {
    app.innerHTML = authForm(`<h1 class="text-center mb-20">Reset Password</h1>
        <p class="mb-20 text-center">Enter your email and we'll send you a link to reset your password.</p>
        <form onsubmit="handlePasswordReset(event)"><div class="form-group"><label for="reset-email">Email Address</label><input type="email" id="reset-email" required></div><button type="submit" class="btn btn-full">Send Reset Link</button></form>
        <p class="text-center mt-20"><a class="text-accent" href="#/login">Back to Login</a></p>`);
}

function renderCart() {
    const cart = getCart();
    if (!cart.length) {
        app.innerHTML = '<div class="text-center empty-state"><h1>Your cart is empty.</h1><a href="#/home" class="btn mt-20">Go Shopping</a></div>';
        return;
    }
    const total = cart.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);
    app.innerHTML = `<h1 class="section-title mt-20">Shopping Cart</h1>
        <div class="cart-list">
            ${cart.map((item, index) => {
                const sizeOption = Object.entries(item.options || {})
                    .find(([name]) => name.toLowerCase() === 'size')?.[1];
                const size = String(item.size || sizeOption || '').trim();
                const color = String(Object.entries(item.options || {})
                    .find(([name]) => name.toLowerCase() === 'color')?.[1] || '').trim();
                const quantity = Math.max(1, Number.parseInt(item.quantity, 10) || 1);
                const unitPrice = Number(item.price) || 0;
                return `<article class="cart-row">
                    <div class="cart-row-main">
                        <div class="cart-product">
                            <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" class="cart-product-image">
                            <div class="cart-product-details">
                                <h2 class="cart-product-name">${escapeHtml(item.name)}</h2>
                                <p class="cart-unit-price">${formatMoney(unitPrice)} <span>each</span></p>
                            </div>
                        </div>
                        <div class="cart-row-actions">
                            ${color ? `<span class="cart-size-badge">Color: ${escapeHtml(color)}</span>` : ''}
                            ${size ? `<span class="cart-size-badge">Size: ${escapeHtml(size)}</span>` : ''}
                            <div class="cart-quantity-control" aria-label="Quantity controls for ${escapeHtml(item.name)}">
                                <button type="button" aria-label="Decrease quantity of ${escapeHtml(item.name)}" onclick="decreaseCartQuantity(${index})">−</button>
                                <span aria-live="polite">${quantity}</span>
                                <button type="button" aria-label="Increase quantity of ${escapeHtml(item.name)}" onclick="increaseCartQuantity(${index})">+</button>
                            </div>
                            <p class="cart-row-total">Subtotal: <strong>${formatMoney(quantity * unitPrice)}</strong></p>
                        </div>
                    </div>
                    <div class="cart-row-remove-wrap">
                        <button type="button" class="cart-row-remove" onclick="removeCartItem(${index})" aria-label="Remove ${escapeHtml(item.name)} from cart">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m9 7 .5 12m5-12-.5 12M4 5h16M10 5V3h4v2m4 0-.8 14.2a2 2 0 0 1-2 1.8H8.8a2 2 0 0 1-2-1.8L6 5"/></svg>
                            Remove
                        </button>
                    </div>
                </article>`;
            }).join('')}
        </div>
        <div class="cart-summary"><div class="summary-row"><span>Subtotal</span><span>${formatMoney(total)}</span></div><div class="summary-row"><span>Shipping</span><span>Free</span></div><div class="summary-total summary-row"><span>Total</span><span>${formatMoney(total)}</span></div><a href="#/checkout" class="btn btn-full mt-20">Checkout via WhatsApp</a></div>`;
}

function renderCheckout() {
    const cart = getCart();
    if (!cart.length) {
        location.hash = '#/home';
        return;
    }
    const total = cart.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);
    app.innerHTML = `<h1 class="section-title mt-20">Checkout</h1>
        <div class="checkout-grid whatsapp-checkout-grid"><section class="checkout-section">
            <h2>Order Summary</h2>
            ${cart.map(item => {
                const options = Object.entries(item.options || {}).map(([name, value]) => `${name}: ${value}`).join(', ');
                return `<div class="order-summary-item"><span>${escapeHtml(item.name)} × ${Number(item.quantity)}${options ? `<small class="order-options">${escapeHtml(options)}</small>` : ''}</span><span>${formatMoney(Number(item.price) * Number(item.quantity))}</span></div>`;
            }).join('')}
            <div class="summary-total summary-row"><span>Total</span><span>${formatMoney(total)}</span></div>
            <p class="payment-note">You'll confirm delivery and payment details with the admin on WhatsApp. No payment information is collected on this website.</p>
            <button type="button" class="btn btn-full mt-20" onclick="processOrder()">Confirm Order on WhatsApp</button>
            <a href="#/cart" class="btn btn-outline btn-full mt-20">Back to Cart</a>
        </section></div>`;
}

function renderOrderSuccess() {
    const orderId = routeInfo().params.get('id') || '';
    const order = getOrderById(orderId);
    const whatsappUrl = order ? `https://wa.me/260961005957?text=${encodeURIComponent(formatOrderMessage(order))}` : '';
    app.innerHTML = `<div class="text-center empty-state"><div class="success-mark" aria-hidden="true">✓</div><h1>Order Confirmed!</h1>
        <p class="mb-20">Thank you for your purchase. Your order <strong>${escapeHtml(orderId)}</strong> is being processed.</p><p>Your order details are saved in the admin dashboard.</p>
        ${whatsappUrl ? `<p class="whatsapp-note">Continue to WhatsApp to share your order with the admin. You will need to press Send in WhatsApp.</p><a class="btn whatsapp-button" href="${whatsappUrl}" target="_blank" rel="noopener noreferrer">Share Order on WhatsApp</a>` : ''}
        <div class="mt-20"><a href="#/home" class="btn">Continue Shopping</a> <a href="#/dashboard" class="btn btn-outline">View Profile</a></div></div>`;
}

function renderAbout() {
    app.innerHTML = `<article class="content-page"><h1 class="section-title">About ${brand}</h1>
        <p class="mb-20">RK General Dealers is here to make shopping for dependable everyday essentials simple and straightforward.</p>
        <p class="mb-20">Our collection brings together useful products for home, work, and leisure, with a focus on quality, value, and friendly service.</p>
        <img class="content-image" src="https://images.unsplash.com/photo-1497366216548-37526070297c?w=1000" alt="A bright, welcoming workspace"></article>`;
}

function renderContact() {
    app.innerHTML = `<div class="form-container"><h1 class="section-title">Get in Touch</h1><p class="mb-20">Have a question? We're here to help.</p>
        <form onsubmit="sendContactMessage(event)">
            <div class="form-group"><label for="contact-name">Name</label><input id="contact-name" required></div>
            <div class="form-group"><label for="contact-email">Email</label><input type="email" id="contact-email" required></div>
            <div class="form-group"><label for="contact-subject">Subject</label><input id="contact-subject" required></div>
            <div class="form-group"><label for="contact-message">Message</label><textarea id="contact-message" rows="5" required></textarea></div>
            <button type="submit" class="btn btn-full">Send Message</button>
        </form></div>`;
}

function renderFaq() {
    const questions = [
        ['How long does shipping take?', 'Domestic shipping typically takes 3-5 business days. International shipping can take 7-14 business days.'],
        ['What is your return policy?', 'We offer a 30-day return policy for all unused items in their original packaging.'],
        ['Do you offer international shipping?', 'Yes, we ship to over 50 countries worldwide. Shipping costs will be calculated at checkout.'],
        ['How can I track my order?', 'Once your order ships, you will receive an email with a tracking number and a link to track your package.']
    ];
    app.innerHTML = `<article class="content-page"><h1 class="section-title">Frequently Asked Questions</h1>${questions.map(([question, answer]) => `<section class="faq-item"><h2 class="faq-question">${question}</h2><p>${answer}</p></section>`).join('')}</article>`;
}

function renderLegal() {
    app.innerHTML = `<article class="content-page legal-page">
        <section id="privacy" class="mb-20"><h1 class="section-title">Privacy Policy</h1><p>Your privacy is important to us. We respect your privacy regarding information we may collect from you through our website.</p><p>We only ask for personal information when we need it to provide a service to you, and collect it by fair and lawful means, with your knowledge and consent.</p></section>
        <hr><section id="terms" class="mb-20"><h2 class="section-title">Terms of Service</h2><p>By accessing our website, you agree to be bound by these terms of service and all applicable laws and regulations.</p></section>
        <hr><section id="returns" class="mb-20"><h2 class="section-title">Returns Policy</h2><p>You have 30 calendar days to return an item from the date you received it. To be eligible, your item must be unused and in the same condition that you received it.</p></section>
    </article>`;
    const section = routeInfo().params.get('section');
    if (section) document.getElementById(section)?.scrollIntoView();
}

function renderDashboard(tab = 'profile') {
    lastDashboardTab = tab;
    const user = getCurrentUser();
    if (!user) {
        location.hash = '#/login';
        return;
    }
    const orders = getMyOrders();
    let content = '';
    if (tab === 'orders') {
        content = `<h2 class="mb-20">Order History</h2>${orders.length ? [...orders].reverse().map(order => `<article class="order-card"><div class="order-header"><div><strong>Order ${escapeHtml(order.id)}</strong><p>Placed on ${escapeHtml(order.date)}</p></div><span class="status-badge">${escapeHtml(order.status)}</span></div><div class="summary-row"><span>${order.items.length} items</span><strong class="text-accent">${formatMoney(order.total)}</strong></div></article>`).join('') : '<p>No orders found.</p>'}`;
    } else if (tab === 'addresses') {
        content = `<h2 class="mb-20">Saved Addresses</h2><article class="order-card"><p>No saved addresses yet.</p></article>`;
    } else {
        content = `<h2 class="mb-20">Profile</h2><div class="form-container profile-form"><div class="form-group"><label for="profile-name">Full Name</label><input id="profile-name" value="${escapeHtml(user.name)}"></div><div class="form-group"><label for="profile-email">Email</label><input type="email" value="${escapeHtml(user.email)}" disabled></div><button class="btn" onclick="updateProfile()">Update Profile</button></div>`;
    }
    app.innerHTML = `<div class="dashboard-grid"><aside class="sidebar">
        <button class="sidebar-link ${tab === 'profile' ? 'active' : ''}" onclick="renderDashboard('profile')">Profile</button>
        <button class="sidebar-link ${tab === 'orders' ? 'active' : ''}" onclick="renderDashboard('orders')">Order History</button>
        <button class="sidebar-link ${tab === 'addresses' ? 'active' : ''}" onclick="renderDashboard('addresses')">Saved Addresses</button>
    </aside><section>${content}</section></div>`;
}

function renderAdmin(tab = 'overview') {
    lastAdminTab = tab;
    const user = getCurrentUser();
    if (!user?.isAdmin) {
        location.hash = '#/login';
        return;
    }
    const products = getProducts();
    const categories = getCategories(products);
    const orders = getAllOrders();
    let content;
    if (tab === 'overview') {
        const sales = orders.reduce((sum, order) => sum + Number(order.total), 0);
        content = `<h2 class="mb-20">Store Overview</h2>
            <div class="stats-grid">
                <div class="stat-card"><p>Total Sales</p><div class="stat-val">${formatMoney(sales)}</div></div>
                <div class="stat-card"><p>Total Orders</p><div class="stat-val">${orders.length}</div></div>
                <div class="stat-card"><p>Products</p><div class="stat-val">${products.length}</div></div>
            </div>`;
    } else if (tab === 'inventory') {
        content = `<div class="section-heading"><h2>Inventory Management</h2><button class="btn" onclick="openProductModal()">+ Add Product</button></div>
            <div class="stats-grid inventory-stats">
                <div class="stat-card"><p>Inventory</p><div class="stat-val">${products.length}</div></div>
                <div class="stat-card"><p>Total Orders</p><div class="stat-val">${orders.length}</div></div>
            </div>
            <section class="category-manager" aria-labelledby="category-manager-title">
                <h3 id="category-manager-title">Product Categories</h3>
                <form class="category-form" onsubmit="addCategory(event)">
                    <label class="sr-only" for="new-category">New category name</label>
                    <input id="new-category" placeholder="New category name" maxlength="40" required>
                    <label class="category-variant-check"><input type="checkbox" id="new-category-variants"> Needs size &amp; color</label>
                    <button class="btn" type="submit">Add Category</button>
                </form>
                <ul class="category-list">${categories.map(category => { const needs = categoryNeedsVariants(category); return `<li><span>${escapeHtml(category)}</span><button type="button" class="category-toggle${needs ? ' is-on' : ''}" aria-pressed="${needs}" aria-label="Size and color for ${escapeHtml(category)}: ${needs ? 'on' : 'off'}" data-category="${escapeHtml(category)}" onclick="toggleCategoryVariants(this)">Size &amp; color: ${needs ? 'On' : 'Off'}</button><button type="button" class="remove-btn" aria-label="Remove ${escapeHtml(category)} category" data-category="${escapeHtml(category)}" onclick="removeCategory(this)">Remove</button></li>`; }).join('')}</ul>
            </section>
            <div class="table-wrap"><table><thead><tr><th>ID</th><th>Photo</th><th>Product</th><th>Category</th><th>Price</th><th>Actions</th></tr></thead><tbody>${products.map(product => `<tr><td>${Number(product.id)}</td><td><img class="inventory-thumb" src="${escapeHtml(product.image)}" alt=""></td><td>${escapeHtml(product.name)}</td><td>${escapeHtml(product.category)}</td><td>${formatMoney(product.price)}</td><td><div class="inventory-actions"><button class="btn btn-outline btn-small" onclick="openProductModal(${Number(product.id)})">Edit</button><button class="remove-btn" onclick="deleteProduct(${Number(product.id)})">Delete</button></div></td></tr>`).join('')}</tbody></table></div>`;
    } else {
        content = `<h2 class="mb-20">Order Tracking</h2><div class="table-wrap"><table><thead><tr><th>Order ID</th><th>Customer</th><th>Email</th><th>Delivery Address</th><th>Items</th><th>Date</th><th>Total</th></tr></thead><tbody>${[...orders].reverse().map(order => `<tr><td>${escapeHtml(order.id)}</td><td>${escapeHtml(order.customer)}</td><td>${escapeHtml(order.email)}</td><td>${escapeHtml(order.address)}, ${escapeHtml(order.city)} ${escapeHtml(order.zip)}</td><td>${order.items.map(item => { const details = Object.entries(item.options || {}).map(([name, value]) => `${name}: ${value}`).join(', '); return `${escapeHtml(item.name)} × ${Number(item.quantity)}${details ? ` <small>(${escapeHtml(details)})</small>` : ''}`; }).join('<br>')}</td><td>${escapeHtml(order.date)}</td><td>${formatMoney(order.total)}</td></tr>`).join('')}</tbody></table></div>`;
    }
    app.innerHTML = `<div class="admin-page">
        <nav class="admin-tabs" aria-label="Admin sections">
            <button type="button" class="admin-tab ${tab === 'overview' ? 'active' : ''}" aria-current="${tab === 'overview' ? 'page' : 'false'}" onclick="renderAdmin('overview')">Overview</button>
            <button type="button" class="admin-tab ${tab === 'inventory' ? 'active' : ''}" aria-current="${tab === 'inventory' ? 'page' : 'false'}" onclick="renderAdmin('inventory')">Inventory</button>
            <button type="button" class="admin-tab ${tab === 'orders' ? 'active' : ''}" aria-current="${tab === 'orders' ? 'page' : 'false'}" onclick="renderAdmin('orders')">Orders</button>
        </nav>
        <section>${content}</section>
    </div>
    <div id="product-modal" class="modal" hidden><div class="form-container modal-content"><h2 class="mb-20" id="product-modal-title">Add New Product</h2><form id="product-form" onsubmit="saveNewProduct(event)">
        <input id="p-id" type="hidden">
        <div class="form-group"><label for="p-name">Name</label><input id="p-name" required></div><div class="form-group"><label for="p-price">Price (K)</label><input id="p-price" type="number" min="0" step="0.01" required></div>
        <div class="form-group"><label for="p-image">Product photos</label><input id="p-image" type="file" accept="image/*" multiple onchange="addProductPhotos(event)"><small class="form-hint">Add up to 7 photos, each up to 2 MB. The first photo is the main photo shown in the shop.</small><div id="product-photo-list" class="photo-list"></div></div><div class="form-group"><label for="p-category">Category</label><select id="p-category" onchange="syncVariantFields()">${categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('')}</select></div>
        <div id="variant-fields" hidden>
            <div class="form-group"><label for="p-colors">Colors</label><input id="p-colors" placeholder="e.g. Black, White, Brown"><small class="form-hint">Separate colors with commas.</small></div>
            <div class="form-group"><label for="p-sizes">Sizes</label><input id="p-sizes" placeholder="e.g. 38, 39, 40, 41"><small class="form-hint">Separate sizes with commas.</small></div>
        </div>
        <div class="form-group"><label for="p-desc">Description</label><textarea id="p-desc"></textarea></div><div class="modal-actions"><button type="submit" class="btn" id="product-save-button">Save Product</button><button type="button" class="btn btn-outline" onclick="closeProductModal()">Cancel</button></div>
    </form></div></div>`;
}

function renderPage() {
    const { page } = routeInfo();
    toggleMenu(true);
    document.title = `${page === 'home' ? 'Shop' : page.replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase())} | ${brand}`;
    const user = getCurrentUser();
    document.getElementById('auth-links').innerHTML = user
        ? `<a href="#/dashboard">Profile</a> ${user.isAdmin ? '<a href="#/admin">Admin</a>' : ''} <a href="#/home" onclick="logout()">Logout</a>`
        : '<a href="#/login">Login</a> <a href="#/register">Register</a>';
    const pages = {
        home: renderHome, search: renderSearch, product: renderProduct, login: renderLogin,
        register: renderRegister, 'forgot-password': renderForgotPassword, cart: renderCart,
        checkout: renderCheckout, success: renderOrderSuccess, about: renderAbout,
        contact: renderContact, faq: renderFaq, legal: renderLegal, dashboard: () => renderDashboard(),
        admin: () => renderAdmin()
    };
    (pages[page] || renderHome)();
    updateCartCount();
}

function searchProducts(event) {
    event.preventDefault();
    const query = document.getElementById('search-input').value.trim();
    location.hash = `#/search?q=${encodeURIComponent(query)}`;
}

function isInCart(productId) {
    return getCart().some(item => Number(item.id) === Number(productId));
}

// Keeps every "Add to Cart" button in step with what is actually in this visitor's cart.
function syncCartButtons() {
    const inCart = new Set(getCart().map(item => String(item.id)));
    document.querySelectorAll('[data-cart-id]').forEach(button => {
        const added = inCart.has(button.dataset.cartId);
        button.classList.toggle('is-added', added);
        button.textContent = added ? 'Added to Cart ✓' : (button.dataset.originalText || 'Add to Cart');
    });
    const summary = document.getElementById('product-cart-summary');
    if (summary) summary.innerHTML = cartSummaryMarkup(summary.dataset.productId);
}

function readSelectedOptions() {
    const selects = [...document.querySelectorAll('.product-option select')];
    const missing = selects.filter(select => !select.value);
    if (missing.length) {
        alert(`Please select ${missing.map(select => select.dataset.optionName.toLowerCase()).join(' and ')}.`);
        missing[0].focus();
        return null;
    }
    return Object.fromEntries(selects.map(select => [select.dataset.optionName, select.value]));
}

function addToCartFromButton(id) {
    const product = getProducts().find(item => Number(item.id) === Number(id));
    if (!product) return;
    if (hasOptions(product)) {
        location.hash = `#/product?id=${encodeURIComponent(id)}`;
    } else if (isInCart(id)) {
        location.hash = '#/cart';
    } else {
        addToCart(id);
    }
}

function addProductQuantity(id) {
    const options = readSelectedOptions();
    if (!options) return;
    const quantityInput = document.getElementById('product-qty');
    const quantity = Math.max(1, Number.parseInt(quantityInput.value, 10) || 1);
    if (!addToCart(id, quantity, options)) return;
    // Ready for the next color / size / quantity choice.
    document.querySelectorAll('.product-option select').forEach(select => { select.selectedIndex = 0; });
    quantityInput.value = 1;
}

function orderProductViaWhatsApp(productId) {
    const products = getProducts();
    const product = products.find(item => Number(item.id) === Number(productId));
    if (!product) {
        alert('This product is no longer available.');
        return;
    }
    const selected = readSelectedOptions();
    if (!selected) return;
    const quantity = Math.max(1, Number.parseInt(document.getElementById('product-qty')?.value, 10) || 1);
    const options = Object.entries(selected).map(([name, value]) => `${name}: ${value}`);
    const sku = product.sku || product.id;
    const message = [
        'Hello! I would like to order:',
        `- Product: ${product.name}`,
        `- SKU: ${sku}`,
        `- Price: ${formatMoney(product.price)}${quantity > 1 ? ` x ${quantity} = ${formatMoney(Number(product.price) * quantity)}` : ''}`,
        `- Options: ${options.length ? options.join(', ') : 'None'}`,
        `Link: ${window.location.href}`
    ].join('\n');
    const whatsappUrl = `https://wa.me/260961005957?text=${encodeURIComponent(message)}`;
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
}

function updateCartQuantity(index, quantity) {
    const cart = getCart();
    const item = cart[Number(index)];
    if (!item) return;
    item.quantity = Math.max(1, Number.parseInt(quantity, 10) || 1);
    saveCart(cart);
    renderCart();
}

function increaseCartQuantity(index) {
    const item = getCart()[Number(index)];
    if (item) updateCartQuantity(index, Number(item.quantity) + 1);
}

function decreaseCartQuantity(index) {
    const item = getCart()[Number(index)];
    if (item) updateCartQuantity(index, Number(item.quantity) - 1);
}

function removeCartItem(index) {
    const cart = getCart();
    cart.splice(Number(index), 1);
    saveCart(cart);
    renderCart();
}

function authErrorMessage(error) {
    switch (error?.code) {
        case 'auth/invalid-credential':
        case 'auth/wrong-password':
        case 'auth/user-not-found':
        case 'auth/invalid-email':
            return 'Invalid email or password.';
        case 'auth/email-already-in-use':
            return 'Email already registered.';
        case 'auth/weak-password':
            return 'Password must be at least 6 characters.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Please try again later.';
        case 'auth/network-request-failed':
            return 'Network error. Check your connection and try again.';
        default:
            return 'Something went wrong. Please try again.';
    }
}

async function handleLogin(event) {
    event.preventDefault();
    const email = document.getElementById('login-email').value.trim().toLowerCase();
    const password = document.getElementById('login-password').value;
    try {
        const credential = await auth.signInWithEmailAndPassword(email, password);
        const user = await waitForUser(credential.user.uid);
        location.hash = user?.isAdmin ? '#/admin' : '#/dashboard';
    } catch (error) {
        console.error(error);
        alert(authErrorMessage(error));
    }
}

async function handleRegister(event) {
    event.preventDefault();
    const name = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    registering = true;
    try {
        const credential = await auth.createUserWithEmailAndPassword(email, password);
        await db.collection('users').doc(credential.user.uid).set({ name, email, isAdmin: false });
        await auth.signOut();
        alert('Registration successful! Please login.');
        location.hash = '#/login';
    } catch (error) {
        console.error(error);
        alert(authErrorMessage(error));
    } finally {
        registering = false;
    }
}

async function handlePasswordReset(event) {
    event.preventDefault();
    const email = document.getElementById('reset-email').value.trim();
    try {
        await auth.sendPasswordResetEmail(email);
    } catch (error) {
        console.error(error);
        if (error.code === 'auth/network-request-failed') {
            alert(authErrorMessage(error));
            return;
        }
    }
    alert('If an account exists for this email, a reset link has been sent.');
    location.hash = '#/login';
}

function sendContactMessage(event) {
    event.preventDefault();
    alert('Message sent! We will get back to you soon.');
    location.hash = '#/home';
}

let processingOrder = false;

async function processOrder() {
    if (processingOrder) return;
    const cart = getCart();
    if (!cart.length) {
        location.hash = '#/cart';
        return;
    }
    processingOrder = true;
    const user = getCurrentUser();
    const order = {
        id: `ORD-${Date.now()}`,
        date: new Date().toLocaleDateString(),
        // Photos are left out so the order stays small; everything shown in orders is kept.
        items: cart.map(item => ({
            id: Number(item.id),
            name: String(item.name),
            price: Number(item.price),
            quantity: Number(item.quantity),
            options: item.options || {}
        })),
        total: cart.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0),
        status: 'Awaiting WhatsApp confirmation',
        customer: user?.name || 'WhatsApp customer',
        email: user?.email || '',
        address: '',
        city: '',
        zip: '',
        uid: user?.uid || null,
        createdAtMs: Date.now()
    };
    try {
        await Promise.race([
            db.collection('orders').doc(order.id).set(order),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Saving the order timed out.')), 8000))
        ]);
    } catch (error) {
        // Never block the sale: the WhatsApp message still carries the full order.
        console.error('Order could not be saved to the database:', error);
    }
    rememberOrder(order);
    const whatsappUrl = `https://wa.me/260961005957?text=${encodeURIComponent(formatCartWhatsAppMessage(order))}`;
    localStorage.removeItem('cart');
    processingOrder = false;
    window.location.assign(whatsappUrl);
}

function formatCartWhatsAppMessage(order) {
    const messageCurrency = new Intl.NumberFormat('en-ZM', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    const money = value => `K${messageCurrency.format(Number(value) || 0)}`;
    const items = order.items.map(item => {
        const options = Object.entries(item.options || {})
            .map(([name, value]) => `${name}: ${value}`)
            .join(', ');
        const details = options ? ` (${options})` : '';
        const subtotal = Number(item.price) * Number(item.quantity);
        return `• ${Number(item.quantity)}x ${item.name}${details} - ${money(subtotal)}`;
    });
    return [
        '🛒 *New Order from Website*',
        '-------------------------',
        ...items,
        '-------------------------',
        `💰 *Total Amount:* ${money(order.total)}`,
        '',
        'Please confirm these products are available.'
    ].join('\n');
}

function formatOrderMessage(order) {
    const items = order.items.map(item => `- ${item.name} x ${item.quantity}: ${formatMoney(Number(item.price) * Number(item.quantity))}`).join('\n');
    return [
        `New order for ${brand}`,
        `Order: ${order.id}`,
        `Customer: ${order.customer}`,
        `Email: ${order.email}`,
        `Delivery: ${order.address}, ${order.city} ${order.zip}`,
        'Items:',
        items,
        `Total: ${formatMoney(order.total)}`,
        `Status: ${order.status}`
    ].join('\n');
}

async function updateProfile() {
    const user = getCurrentUser();
    if (!user) return;
    const name = document.getElementById('profile-name').value.trim();
    try {
        await db.collection('users').doc(user.uid).update({ name });
    } catch (error) {
        console.error(error);
        alert('Profile could not be updated. Check your connection and try again.');
        return;
    }
    user.name = name;
    alert('Profile updated.');
    renderDashboard('profile');
}

function getCategories(products = getProducts()) {
    return [...new Set([...getSavedCategories(), ...products.map(product => product.category).filter(Boolean)])]
        .sort((a, b) => a.localeCompare(b));
}

function categoryNeedsVariants(category) {
    return getVariantCategories().includes(category);
}

async function saveCategories(categories, variantCategories = getVariantCategories()) {
    try {
        await db.doc('meta/categories').set({
            list: categories,
            variantCategories: variantCategories.filter(category => categories.includes(category))
        });
        return true;
    } catch (error) {
        console.error(error);
        alert('Categories could not be saved. Check your connection.');
        return false;
    }
}

async function addCategory(event) {
    event.preventDefault();
    const input = document.getElementById('new-category');
    const name = input.value.trim();
    const needsVariants = document.getElementById('new-category-variants').checked;
    const categories = getCategories();
    if (categories.some(category => category.toLowerCase() === name.toLowerCase())) {
        alert('That category already exists.');
        return;
    }
    categories.push(name);
    const variantCategories = needsVariants ? [...getVariantCategories(), name] : getVariantCategories();
    if (await saveCategories(categories, variantCategories)) renderAdmin('inventory');
}

async function toggleCategoryVariants(button) {
    const category = button.dataset.category;
    const current = getVariantCategories();
    const next = current.includes(category) ? current.filter(item => item !== category) : [...current, category];
    if (await saveCategories(getCategories(), next)) renderAdmin('inventory');
}

async function removeCategory(button) {
    const category = button.dataset.category;
    if (getProducts().some(product => product.category === category)) {
        alert('This category is assigned to products. Reassign those products before removing it.');
        return;
    }
    const categories = getSavedCategories().filter(item => item !== category);
    if (await saveCategories(categories)) renderAdmin('inventory');
}

const MAX_PHOTOS = 7;
const PHOTO_BUDGET = 115000; // characters per photo, so 7 photos always fit in one 1 MB Firestore document
let modalPhotos = [];

function renderPhotoList() {
    const list = document.getElementById('product-photo-list');
    if (!list) return;
    list.innerHTML = modalPhotos.map((src, index) => `<div class="photo-thumb">
        <img src="${escapeHtml(src)}" alt="Product photo ${index + 1}">
        ${index === 0 ? '<span class="photo-main-tag">Main</span>' : `<button type="button" class="photo-main-btn" onclick="makeMainPhoto(${index})">Make main</button>`}
        <button type="button" class="photo-remove" aria-label="Remove photo ${index + 1}" onclick="removeProductPhoto(${index})">×</button>
    </div>`).join('');
}

function removeProductPhoto(index) {
    modalPhotos.splice(index, 1);
    renderPhotoList();
}

function makeMainPhoto(index) {
    const [photo] = modalPhotos.splice(index, 1);
    modalPhotos.unshift(photo);
    renderPhotoList();
}

async function addProductPhotos(event) {
    const input = event.target;
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    const room = MAX_PHOTOS - modalPhotos.length;
    if (room <= 0) {
        alert('You can add up to 7 photos per product.');
        return;
    }
    if (files.length > room) {
        alert(`Only ${room} more photo${room === 1 ? '' : 's'} can be added (7 maximum). The first ${room} were kept.`);
    }
    for (const file of files.slice(0, room)) {
        if (!file.type.startsWith('image/')) {
            alert(`"${file.name}" is not an image file.`);
            continue;
        }
        if (file.size > 2 * 1024 * 1024) {
            alert(`"${file.name}" is larger than 2 MB.`);
            continue;
        }
        try {
            const photo = await compressImage(file);
            if (modalPhotos.length < MAX_PHOTOS) modalPhotos.push(photo);
            renderPhotoList();
        } catch (error) {
            alert(error.message);
        }
    }
}

function syncVariantFields() {
    const category = document.getElementById('p-category').value;
    document.getElementById('variant-fields').hidden = !categoryNeedsVariants(category);
}

function openProductModal(productId = null) {
    const form = document.getElementById('product-form');
    const product = productId === null
        ? null
        : getProducts().find(item => Number(item.id) === Number(productId));
    if (productId !== null && !product) {
        alert('Product could not be found.');
        return;
    }
    form.reset();
    document.getElementById('p-id').value = product ? String(product.id) : '';
    document.getElementById('p-name').value = product?.name || '';
    document.getElementById('p-price').value = product?.price ?? '';
    const categorySelect = document.getElementById('p-category');
    const wantedCategory = product?.category || 'Electronics';
    categorySelect.value = [...categorySelect.options].some(option => option.value === wantedCategory)
        ? wantedCategory
        : (categorySelect.options[0]?.value ?? '');
    document.getElementById('p-desc').value = product?.description || '';
    document.getElementById('p-colors').value = (product?.options?.Color || []).join(', ');
    document.getElementById('p-sizes').value = (product?.options?.Size || []).join(', ');
    syncVariantFields();
    document.getElementById('product-modal-title').textContent = product ? 'Edit Product' : 'Add New Product';
    document.getElementById('product-save-button').textContent = product ? 'Save Changes' : 'Save Product';
    modalPhotos = product ? getProductPhotos(product) : [];
    renderPhotoList();
    document.getElementById('product-modal').hidden = false;
}

function closeProductModal() {
    document.getElementById('product-modal').hidden = true;
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('The selected photo could not be read.'));
        img.src = src;
    });
}

// Accepts a File or an existing data URL; returns a JPEG data URL within the per-photo size budget.
async function compressImage(source, budget = PHOTO_BUDGET) {
    const isFile = typeof source !== 'string';
    const url = isFile ? URL.createObjectURL(source) : source;
    try {
        const img = await loadImage(url);
        let side = 800;
        let quality = 0.8;
        for (let attempt = 0; attempt < 14; attempt++) {
            const scale = Math.min(1, side / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(img, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            if (dataUrl.length <= budget) return dataUrl;
            if (quality > 0.5) quality -= 0.1;
            else side = Math.round(side * 0.85);
        }
        throw new Error('That photo is too detailed to store. Try a smaller image.');
    } finally {
        if (isFile) URL.revokeObjectURL(url);
    }
}

function splitList(value) {
    const items = String(value || '').split(',').map(item => item.trim().slice(0, 40)).filter(Boolean);
    const seen = new Set();
    return items.filter(item => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 40);
}

let savingProduct = false;

async function saveNewProduct(event) {
    event.preventDefault();
    if (savingProduct) return;
    if (!modalPhotos.length) {
        alert('Add at least one product photo before saving.');
        return;
    }
    const products = getProducts();
    const productId = document.getElementById('p-id').value;
    const existingIndex = products.findIndex(product => String(product.id) === productId);
    const category = document.getElementById('p-category').value;
    savingProduct = true;
    try {
        // Older photos saved at a larger size are shrunk so all photos fit in one document.
        const photos = await Promise.all(modalPhotos.map(src => src.length > PHOTO_BUDGET ? compressImage(src) : src));
        const product = {
            id: existingIndex >= 0 ? products[existingIndex].id : Date.now(),
            name: document.getElementById('p-name').value.trim(),
            price: Number(document.getElementById('p-price').value),
            image: photos[0],
            gallery: photos.slice(1),
            category,
            description: document.getElementById('p-desc').value.trim()
        };
        if (categoryNeedsVariants(category)) {
            const colors = splitList(document.getElementById('p-colors').value);
            const sizes = splitList(document.getElementById('p-sizes').value);
            if (!colors.length || !sizes.length) {
                alert('Enter at least one color and one size for this category.');
                return;
            }
            product.options = { Color: colors, Size: sizes };
        }
        await db.collection('products').doc(String(product.id)).set(product);
    } catch (error) {
        console.error(error);
        alert(error.code
            ? 'Product could not be saved. Check your connection.'
            : error.message);
        return;
    } finally {
        savingProduct = false;
    }
    closeProductModal();
    renderAdmin('inventory');
}

async function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    try {
        await db.collection('products').doc(String(id)).delete();
    } catch (error) {
        console.error(error);
        alert('Product could not be deleted. Check your connection.');
        return;
    }
    renderAdmin('inventory');
}

document.getElementById('primary-navigation').addEventListener('click', event => {
    if (event.target.closest('a')) toggleMenu(true);
});
// Re-draw the current page when shared data changes on another device,
// without interrupting typing, an open product form, or the current tab.
function refreshView() {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const { page } = routeInfo();
    if (page === 'home') renderHome();
    else if (page === 'search') renderSearch();
    else if (page === 'admin') {
        if (document.getElementById('product-modal')?.hidden === false) return;
        renderAdmin(lastAdminTab);
    } else if (page === 'dashboard' && lastDashboardTab === 'orders') renderDashboard('orders');
}

window.addEventListener('hashchange', () => {
    if (appReady) renderPage();
});

(async function boot() {
    app.innerHTML = '<p class="text-center mt-20">Loading…</p>';
    await dataReady;
    appReady = true;
    if (!location.hash) location.hash = '#/home';
    else renderPage();
})();
