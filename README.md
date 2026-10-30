# RK General Dealers

The storefront is a single-page app served from `index.html`. Navigation uses hash routes, while `styles.css` contains the black-and-orange theme and `common.js` handles Firebase and the shared product and cart data.

Prices are displayed in Zambian kwacha (K).

## Firebase

Products, categories, customer accounts and orders are stored in Firebase (project `rk-main-c7124`):

- **Authentication** (Email/Password) handles register, login and password reset.
- **Firestore** stores `products`, `meta/categories`, `users` and `orders`. Security rules are in `firestore.rules`; paste them in the Firebase console under Firestore Database > Rules and publish.
- Each product can have up to 7 photos. They are compressed in the browser (max 800 px) and stored inside the product document. The first photo is the main one; the rest appear as a gallery on the product page.
- The shopping cart still lives in each visitor's browser (localStorage).

### Making someone an admin
1. Register the account on the site.
2. In the Firebase console open Firestore Database > `users` > that user's document.
3. Set `isAdmin` to `true` (boolean). Admin rights can only be granted here, never from the website.

## Checkout
Checkout saves the order to Firestore for the admin dashboard and opens a prefilled WhatsApp message to the admin; it does not collect card or payment details. The order message lists each product, quantity, selected options, and the total in kwacha. The customer must press **Send** in WhatsApp.

## Categories with size & color
In Admin > Inventory, each category has a **Size & color** switch (tick it when adding the category, or flip it later). For products in such a category the product form asks for the available colors and sizes (comma-separated). On the product page the customer picks a color, a size and a quantity, and can add several combinations; each one is its own line in the cart and in the order.

Whenever `firestore.rules` changes, paste it into the Firebase console (Firestore Database > Rules) and publish.
