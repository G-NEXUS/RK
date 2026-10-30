# RK General Dealers

The storefront is a single-page app served from `index.html`. Navigation uses hash routes, while `styles.css` contains the black-and-orange theme and `common.js` handles the shared product and cart data.

Open `index.html` in a browser to use the shop, account pages, checkout, dashboards, and support pages.

Prices are displayed in Zambian kwacha (K). Admins can add and edit products in Inventory using an uploaded image (up to 2 MB); product data and photos are stored in that browser's local storage.

Admins can also add categories in Inventory and select them when adding or editing products. Customer accounts open the Profile view after login; the Shop remains the default landing page.

Demo login accounts:
- Customer: `customer@rk.com` / `customer123`
- Admin: `admin@rk.com` / `admin123`

Checkout records orders in this browser's local storage for the admin dashboard and opens a prefilled WhatsApp message to the admin; it does not collect card or payment details. The order message lists each product, quantity, selected options, and the total in kwacha. The customer must press **Send** in WhatsApp. This static demo does not synchronize orders between different devices; shared admin access requires a server-side order store.