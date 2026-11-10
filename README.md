# RK CONNEKT

The storefront is a single-page app served from `index.html`. Navigation uses hash routes, while `styles.css` contains the black-and-orange theme and `common.js` handles the shared product and cart data through the Render API.

Prices are displayed in Zambian kwacha (K).

## MongoDB and Render

Products, categories, customer accounts, orders and messages are stored in MongoDB through the Express API in `server.js`. Render serves both the API and the existing static frontend from one web service.

- **Authentication** remains Firebase Email/Password for the staged migration. The browser sends Firebase ID tokens to Render, and the API verifies them with Firebase Admin before reading or writing MongoDB. Admin access is controlled by the server-side `isAdmin` field.
- **MongoDB** stores `products`, `meta`, `users`, `orders`, `messages` and password-reset records.
- Each product can have up to 7 photos. They are compressed in the browser (max 800 px) and stored inside the product document. The first photo is the main one; the rest appear as a gallery on the product page.
- The shopping cart still lives in each visitor's browser (localStorage).

### Making someone an admin
Set `isAdmin` to `true` directly on the user document in MongoDB Atlas. Admin routes verify this value on the server; it is never accepted from the browser as authorization.

## Checkout
Checkout saves the order to Firestore for the admin dashboard and opens a prefilled WhatsApp message to the admin; it does not collect card or payment details. The order message lists each product, quantity, selected options, and the total in kwacha. The customer must press **Send** in WhatsApp.

## Categories with size and color
In Admin > Inventory, each category has two separate switches: **Size** and **Color** (tick either or both when adding the category, or flip them later). For products in a category, the product form asks only for the options that are switched on (comma-separated lists). On the product page the customer picks those options and a quantity, and can add several combinations; each one is its own line in the cart and in the order.

Set `MONGODB_URI`, `MONGODB_DB` and `FIREBASE_SERVICE_ACCOUNT_JSON` in Render. Keep `.env` local only and never commit it.

### Existing Firebase data

The existing product, category, order and contact data must be exported from Firebase and imported into MongoDB before cutover. Firebase Authentication remains the identity source during this staged migration, so existing customer passwords and account recovery continue to work. Firestore can be disabled only after the MongoDB data import and Render API have been verified.

## Bulk price
In the product form, **Bulk price** and **Bulk price applies from this quantity** (both optional). The card shows the bulk price in small text under the normal price. When a customer's cart holds at least that many of the product (all colors and sizes together), every unit of it is charged the bulk price in the cart, checkout, WhatsApp message and saved order.

## Shop layout
Goods are shown in one block per category (no headings), in category order.

## Reports
In Admin > Orders, for each item enter how many units were **Sold** and how many were **Unavailable** (for example ordered 5: 3 sold, 2 unavailable), or use *All sold* / *All unavailable* for a whole order. The **Reports** tab adds this up per month: *made* (sold items), *lost* (unavailable items) and items not marked yet, with a per-product breakdown and a history of all months. The figures are calculated whenever the tab is opened, so a month's report is complete as soon as the month ends.

## Contact messages
The Contact page saves each message to Firestore (`messages`). In Admin > **Contacts** the admin sees all messages (newest first) and can mark them read or unread or delete them. The tab shows a badge with the number of unread messages. Visitors do not need to be logged in to send a message.

## Where things live
`index.html` holds the fixed parts of the site: the header, footer, loading placeholder cards, the footer animation text, and the About, Contact, FAQ, Legal, Login, Register and Reset Password pages (as `<template>` blocks), plus the admin product popup. `common.js` holds only what depends on data or behavior.

## Ordering needs an account
Visitors can browse and fill a cart without an account, but checkout and *Order via WhatsApp* ask them to log in or register first (and bring them back to what they were doing afterwards). Firestore also refuses orders from logged-out visitors. Anyone who is already logged in is sent straight to their profile (or the admin page) if they open the Login, Register or Reset Password pages.
