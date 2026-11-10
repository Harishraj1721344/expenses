# Expense Book (saves to Google Sheets)

Plain HTML, CSS and JavaScript on GitHub Pages. All data is saved in **your Google Sheet**.
Nothing is stored in the browser except the sign-in token.

Files
- `index.html`, `style.css`, `app.js`, `config.js`  the website (upload these to GitHub)
- `Code.gs`  the Google Apps Script that reads and writes your Sheet (paste this into Google, not GitHub)

## Part 1: Google Sheet and script (about 5 minutes)

1. Create a new blank Google Sheet. In **File > Settings**, set the time zone to **(GMT+05:30) India Standard Time**.
2. Open **Extensions > Apps Script**. Delete the sample code and paste all of `Code.gs`.
3. At the top, change `const SIGNUP_CODE = 'change-me';` to your own secret code, for example `'family2026'`.
   Anyone creating an account must type this code. Sign-up is blocked until you change it.
4. Press **Save**. In the function menu choose **setup** and press **Run**. Approve the permissions.
   (Google shows "unverified app" because it is your own script: Advanced > Go to project.)
   This creates the sheets: Users, Expenses, Lists, Summary.
5. Press **Deploy > New deployment**. Click the gear and choose **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   Press **Deploy** and copy the **Web app URL** (ends with `/exec`).

## Part 2: Website on GitHub

1. Open `config.js` and paste the URL between the quotes: `API_URL: 'https://script.google.com/macros/s/.../exec'`
2. Create a GitHub repository and upload `index.html`, `style.css`, `app.js` and `config.js`.
3. **Settings > Pages > Deploy from a branch > main > / (root) > Save**.
4. Open `https://<your-username>.github.io/<repo-name>/`, choose **Create account**, enter the sign-up code, and start adding expenses.

## Settings, cards and credit card bills

- **Settings** tab: manage your **Cards**, **Banks** and **Categories**. Everything is saved in your Google Sheet.
- **Cards:** only the cards listed here appear on the expense form. The first time you sign in you get
  Axis Neo, Axis Flipkart, HDFC Freedom and SBI Infinity, with banks Axis, HDFC, SBI, Kotak and Indian Bank.
  Add, remove or change them in Settings. Each card has a bank, and **choosing a card on an expense fills in its bank automatically**.
  Leave the card empty for cash or UPI expenses and pick a bank yourself, if you want.
- **Bill date:** for each credit card, type the day of the month its bill is generated (for example 13 for HDFC Freedom). Leave it empty for non-credit cards.
- **Card bills** tab: for each card with a bill date you see what you have spent since the last bill, the next bill date and days left,
  the last bill total, and every bill with its entries listed date-wise.
- **Dashboard** (opens first): spending this month, comparison with last month, average per day, month-end estimate,
  your credit card bills, spending by day, category chart, last six months, latest entries, and breakdowns by bank and card.
- **How entries are grouped:** with a bill date of 13, the bill of 13 Nov covers 14 Oct to 13 Nov. An expense on the 13th goes
  into that bill. A bill date of 31 uses the last day of shorter months.
- Banks' own statement cut-off can differ by a day. Compare with your first real statement and, if needed, set the date one day earlier or later.
- A card cannot be renamed. To change a name, add the new card and remove the old one (past expenses keep the old name).

## If you already deployed an earlier version

Paste the new `Code.gs` over the old one, press Save, then **Deploy > Manage deployments > pencil > Version: New version > Deploy**.
You do not need to run `setup` again, and the Web app URL stays the same. Cards and bill dates saved by the earlier version are converted automatically. Then upload the new `index.html`, `style.css` and `app.js` to GitHub.

## Using the Sheet

- **Lists** sheet holds your categories, banks and cards. A card is one row, written like `HDFC Freedom|HDFC|13` (card name, bank, bill date).
- **Expenses** sheet: every entry (ID, Username, Date, Note, Category, Amount, Card, Bank).
- **Summary** sheet: month-wise totals by category, bank and card. Type a username in the yellow cell (B1) and a year in B2.
- Avoid editing the ID and Username columns by hand. You can edit other cells, and the site shows the change next time it loads.

## Changing the script later

After editing `Code.gs`, press **Deploy > Manage deployments > pencil icon > Version: New version > Deploy**.
The Web app URL stays the same.

## Security notes

- Passwords are stored in the Users sheet as salted hashes, never as plain text.
- Sign-in uses a signed token that lasts 30 days. 5 wrong passwords lock that username for 10 minutes.
- The Web app URL is public, but nothing can be read or written without signing in.
- You (the Sheet owner) can see every user's expenses, because they are in your Sheet. Only share the sign-up code with people you trust.
- Do not type real card numbers in the Note field. Card and Bank are just names such as "Credit Card" and "HDFC".
