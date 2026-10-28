// Shared storefront data and cart helpers.

document.addEventListener('DOMContentLoaded', () => {
    updateCartCount();
    checkLoginStatus();
});

// Mock Database / Initial Products
const initialProducts = [
    { id: 1, name: "Classic Watch", price: 120, image: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400", category: "Accessories", description: "A timeless classic for every occasion." },
    { id: 2, name: "Noise-Cancelling Headphones", price: 85, image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400", category: "Electronics", description: "Immerse yourself in sound without distractions." },
    { id: 3, name: "Digital DSLR Camera", price: 450, image: "https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=400", category: "Electronics", description: "Capture life's moments in stunning detail." },
    { id: 4, name: "Premium Sport Shoes", price: 99, image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400", category: "Apparel", description: "Engineered for comfort and performance." },
    { id: 5, name: "Minimalist Backpack", price: 65, image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=400", category: "Accessories", description: "Sleek design with maximum storage." },
    { id: 6, name: "Mechanical Keyboard", price: 150, image: "https://images.unsplash.com/photo-1511467687858-23d96c32e4ae?w=400", category: "Electronics", description: "Tactile feedback for the ultimate typing experience." },
    { id: 7, name: "Smart Fitness Tracker", price: 45, image: "https://images.unsplash.com/photo-1575311373937-040b8e1fd5b6?w=400", category: "Electronics", description: "Monitor your health and activity 24/7." },
    { id: 8, name: "Leather Wallet", price: 35, image: "https://images.unsplash.com/photo-1627123424574-724758594e93?w=400", category: "Accessories", description: "Genuine leather with a slim profile." },
    { id: 9, name: "Wireless Gaming Mouse", price: 75, image: "https://images.unsplash.com/photo-1527814732934-94a1fe71fe73?w=400", category: "Electronics", description: "Precision and speed for competitive gaming." },
    { id: 10, name: "Bluetooth Speaker", price: 55, image: "https://images.unsplash.com/photo-1608156639585-34a0a56ee6c9?w=400", category: "Electronics", description: "Powerful sound in a portable design." }
];

const initialCategories = ["Electronics", "Accessories", "Apparel"];

// Initialize LocalStorage if empty
if (!localStorage.getItem('products')) {
    localStorage.setItem('products', JSON.stringify(initialProducts));
}

if (!localStorage.getItem('categories')) {
    localStorage.setItem('categories', JSON.stringify(initialCategories));
}

// Cart Functions
function getCart() {
    return JSON.parse(localStorage.getItem('cart')) || [];
}

function saveCart(cart) {
    localStorage.setItem('cart', JSON.stringify(cart));
    updateCartCount();
}

function addToCart(productId, quantity = 1, options = {}) {
    const products = JSON.parse(localStorage.getItem('products')) || [];
    const product = products.find(p => Number(p.id) === Number(productId));
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

// Auth Functions
function checkLoginStatus() {
    const user = JSON.parse(localStorage.getItem('currentUser'));
    const authLinks = document.getElementById('auth-links');
    if (authLinks) {
        if (user) {
            authLinks.innerHTML = `
                <a href="#/dashboard">Dashboard</a>
                ${user.isAdmin ? '<a href="#/admin">Admin</a>' : ''}
                <a href="#/home" onclick="logout()">Logout</a>
            `;
        } else {
            authLinks.innerHTML = `
                <a href="#/login">Login</a>
                <a href="#/register">Register</a>
            `;
        }
    }
}

function logout() {
    localStorage.removeItem('currentUser');
    window.location.hash = '#/home';
}

// Search Function
function performSearch() {
    const query = document.getElementById('search-input').value;
    if (query) {
        window.location.hash = `#/search?q=${encodeURIComponent(query)}`;
    }
}
