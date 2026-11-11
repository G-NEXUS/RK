# RK CONNEKT

The storefront is a single-page app served from `index.html`. Navigation uses hash routes, while `styles.css` contains the black-and-orange theme and `common.js` handles the shared product and cart data through the Render API.

Prices are displayed in Zambian kwacha (K).

## MongoDB and Render

Products, categories, customer accounts, orders and messages are stored in MongoDB through the Express API in `server.js`. Render serves both the API and the existing static frontend from one web service.

- **Authentication** is MongoDB-only. Passwords are hashed with bcrypt and never stored in the browser or returned by the API.
- **Sessions** are random bearer tokens stored only as SHA-256 hashes in MongoDB and expire after 30 days. Logout invalidates the session.
- **Password reset** uses single-use, 30-minute reset tokens stored as hashes. Email delivery uses the optional SMTP variables documented below.
- **MongoDB** stores `products`, `meta`, `users`, `sessions`, `passwordResets`, `orders` and `messages`.
- The shopping cart still lives in each visitor's browser (localStorage).

### Making someone an admin

Set `isAdmin` to `true` directly on the user document in MongoDB Atlas. Admin routes verify this value on the server; it is never accepted from the browser as authorization.

## Render environment

Set these variables in Render:

```text
MONGODB_URI=...
MONGODB_DB=rk_connekt
PUBLIC_APP_URL=https://your-render-service.onrender.com
CORS_ORIGIN=https://your-render-service.onrender.com
```

For working password-reset emails, also set:

```text
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
RESET_FROM_EMAIL=...
```

To import the remaining public catalog from the old Firestore database, temporarily set `MIGRATE_CATALOG_FROM_FIRESTORE=true` in Render and deploy once. The service imports products and category metadata without deleting MongoDB records. Set it back to `false` or remove it after the deployment log says `Catalog migration complete`.

If SMTP is not configured, reset links are written to the server log for administrator-assisted recovery; users are never shown the token in the browser.

## Checkout

Checkout saves the order to MongoDB for the admin dashboard and opens a prefilled WhatsApp message to the admin; it does not collect card or payment details. The customer must press **Send** in WhatsApp.

## Categories, products and reports

In Admin > Inventory, each category has separate Size and Color switches. Products can have up to 7 compressed photos, optional bulk pricing, and selectable options. Admin > Orders supports sold/unavailable tracking and monthly reports. Contact messages are stored in MongoDB and managed from Admin > Contacts.

## Where things live

`index.html` holds the fixed parts of the site and page templates. `common.js` holds frontend behavior and API access. `server.js` holds the Render API, MongoDB persistence, sessions and password reset logic.

## Ordering needs an account

Visitors can browse and fill a cart without an account, but checkout and *Order via WhatsApp* ask them to log in or register first and bring them back to what they were doing afterwards.
