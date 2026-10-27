# Basirah admin dashboard

A private back office for submissions, payment verification, packages and report delivery.
It runs on the same Netlify site as the public page, so there is nothing new to host.

## What is in this folder
| Path | What it is |
|---|---|
| `admin/index.html` | The dashboard (opens at `yoursite.netlify.app/admin/`) |
| `admin/studio.html` | The feedback report writer (PDF), linked from each client |
| `netlify/functions/submissions.mjs` | Receives each finished assessment from the website and stores it |
| `netlify/functions/admin.mjs` | The password-protected API the dashboard uses |
| `netlify/functions/settings.mjs` | Lets the website read your WhatsApp numbers and ways to pay |
| `netlify/functions/report.mjs` | Opens a client’s report from its private link |
| `netlify/lib/core.mjs` | All the rules (statuses, prices, who can change what) |
| `netlify.toml` | Keeps `/admin` out of search engines (merge into yours if you have one) |
| `package.json` | Adds the `@netlify/blobs` storage dependency (merge into yours if you have one) |
| `dev/` | Local preview and tests |

## Set up (about 10 minutes)
1. Put the polished `index.html` in your site, replacing the old one.
2. Copy `admin/`, `netlify/` into your site project, and merge `package.json` and `netlify.toml`.
3. In Netlify, go to Site configuration, Environment variables, and add `ADMIN_PASSWORD` with a long password. Optionally add `ADMIN_SECRET` (any long random text).
4. Deploy, then open `/admin/` and sign in.

If your site already has a catch-all redirect such as `/api/*`, check that it does not capture `/api/submissions` and `/api/admin`.

## WhatsApp, ways to pay and messages (Settings page)

Open **Settings** in the dashboard. Nothing here needs code, and changes go live on the website within a minute.

- **WhatsApp numbers:** add one or several (for example Consultations and Support). The website then shows a round WhatsApp button, a tile in the Contact section, and buttons on the payment help line and on the confirmation screen (with the client’s code already in the message). Normal WhatsApp and WhatsApp Business numbers both work. Press **Test** to check a number.
- **Ways to pay:** add STC Pay, bank transfer (IBAN), Apple Pay, a payment link, or anything else, each with its own notes and up to 4 QR codes. Clients pick one on the payment step, can copy the number or IBAN with one tap, and the record shows what they paid with. If you add nothing, clients see the original QR code exactly as before. Apple Pay cannot be paid to a plain number: add a checkout link from your payment provider.
- **Message wording:** edit the English and Arabic messages you send from a client’s record.

### Messaging a client
Open a client and use **Message the client**: pick a message (payment received, payment problem, report ready, offer or confirm a consultation, or write your own), check the language, and press **Open WhatsApp**. The message is ready in WhatsApp for you to send. Each message you start is noted in the client’s activity list.

### Sending the PDF
There are two ways. The first is recommended.

1. **Send the link (best for the client).** In the studio press **Send to client**, then **Create private link**. The client receives a message with a link such as `yoursite.netlify.app/r/…`. It opens a clean page in their language with a **Download PDF** button, an **Open in your browser** button and a WhatsApp button for questions or booking. It works on any phone, nothing has to be attached, and they can come back to it later. In the dashboard you can see when they opened it and when they downloaded it. **Stop sharing** switches the link off immediately, and deleting the client removes it. The PDF can be up to 4 MB.
2. **Attach the PDF yourself.** In the client’s record choose **Send report as PDF**. Press **Download the PDF**, then **Open WhatsApp**, and attach the file with the paperclip. The message already says the report is attached.

Anyone who has the link can open the PDF, so send it only to that client.

## Questions (change the assessment questions)

Open **Questions** in the dashboard menu. You will see all 38 questions, English and Arabic side by side.

- **Reorder:** drag the dotted handle, or use the up and down arrows.
- **Edit:** type directly in the English or Arabic box.
- **Add or delete:** "+ Add a question" at the bottom; the cross deletes one. **Hide** keeps a question in your list but removes it from the website.
- **Answer:** every question is **Required** by default, so clients must type or record an answer to continue and there is no "Prefer not to answer" button. If you ever want a question to be optional, set it to *Can be skipped* and the button comes back for that question only.
- Press **Save changes**. New assessments use the new list straight away. Someone halfway through keeps their answers, matched to the right questions even if you reordered them.
- **Go back to the original questions** restores the built-in 38 at any time.

Answers already submitted keep the question wording the client saw.

## Reviews

1. Open a client, choose **Ask for a review** in the message box, and send it on WhatsApp. This creates a private link (`/v/...`) for that client. It works once.
2. The client answers on their phone, in English or Arabic. At the end they can agree to have their words shown on your website, and choose how their name appears.
3. **Reviews** in the admin has two tabs. **Client reviews** shows the summary (average rating, would-recommend score, answer rate), every review, and for each one who agreed: pick the words, edit them, add an Arabic version, and press **Show on website**. **Review questions** lets you change, reorder, hide and add the questions, and choose the kind of answer (stars, 0 to 10, or written).
4. Chosen reviews appear on the website in a "Kind words from our clients" section. Nothing shows unless you choose it and the client agreed.

## WhatsApp messages and the logo

WhatsApp cannot attach a picture through a link, so each default message ends with your Basirah link (`/s`), which WhatsApp shows as a card with the logo. The report and review links show the logo card too. For the logo to also appear on your chats, set it as the profile picture of your WhatsApp Business number (the file is `icons/icon-512.png`). The default messages were rewritten in a warmer Basirah voice. If you had edited a message in Settings, your own wording is kept.

## Delivery deadlines, delay notices and reminders

- **Delivery queue** shows how many reports are overdue, due soon and on track, and a progress bar on each client.
- A red or amber **banner** appears on every page when something is overdue or nearly due, and the browser tab shows the count, for example (2) Basirah Admin.
- **Notify of delay** opens a ready, apologetic message (English or Arabic). Pick the new delivery time you can really keep and the message updates. Sending it is recorded, and the queue shows "Delay notice sent 2h ago". You can edit the wording in Settings under message wording.
- **Alert me** (on the queue page) gives a notification and a soft sound when a report becomes nearly due or overdue. It works while the admin is open (a pinned tab or the phone app).
- For an alarm that rings even when the app is closed, press the clock button on a client, or **Add all to my calendar**. Open the downloaded file and your phone calendar reminds you 3 hours and 1 hour before each deadline.

## Phone numbers from any country

Wherever a mobile or WhatsApp number is entered there is now a country picker (Saudi Arabia +966 first, then the Philippines +63, other Gulf and Arab countries, and about 100 countries in all). On the website, the client picks a country and types the number without the code; a leading 0 is removed for them. If a country is missing they can type the full number starting with +. In the admin (Settings numbers and the message box) choosing a country writes its code at the start, and typing a code picks the country. Numbers are saved in full international form, so WhatsApp links work for every country.

## Reviews and WhatsApp messages

- After a report is delivered, open the client: a prompt offers **Ask for a review**. It fills a WhatsApp message with the client's private review link.
- **Reviews > Review questions** lets you edit, reorder, hide and add the questions, and choose how reviewer names appear: the client chooses, always first name, always full name, or always anonymous.
- **Reviews > Client reviews** shows the summary (average rating, would-recommend score, answers per question). Press **Show on website** on the reviews you want clients to see, and edit the words or name first if you like.
- Every WhatsApp message carries a link. WhatsApp turns the link into a card with the Basirah logo. A message itself cannot hold a picture, so set the Basirah logo as your WhatsApp profile photo too.
- The default messages are written in a warmer Basirah voice and end with a signature. You can still edit them in Settings.
- Content and buttons keep clear of Netlify's badge on every screen.

## Growth & revenue

The **Growth & revenue** page shows verified revenue, new assessments, paid clients, average order, payment check rate, average delivery time and the share delivered within 24 hours. Choose 7 days, 30 days, 90 days or all time. Each figure compares with the period before it. Below are charts over time, a submission-to-delivery funnel, results by package, how clients pay, how they want their report, language, and all-time totals.

## Packages (prices, names and wording)

Open **Packages** in the admin. Under the statistics, **Edit what clients see** lets you change each package's price, name and description (English and Arabic), hide a package, and change the "assessment length" and "report delivery" times. The website keeps its look and updates after you press **Save changes**. The server charges the saved price, and clients who already paid keep the price they were charged. **Go back to the original packages** restores SAR 200 and SAR 400.

## Many devices, and the phone app view

- **Any number of devices** can be signed in at once (phones, tablets, computers). Sessions are not counted. Everyone uses the same password. Tick "Keep me signed in" to stay signed in for 30 days on that device.
- **Settings > Your links and phone app** shows the client website link (copy, or share on WhatsApp) and your private admin link.
- **Phone app view:** iPhone, open the link in Safari, Share, **Add to Home Screen**. Android, open in Chrome, the ⋮ menu, **Install app**. It opens full screen with no browser bars. Do this once for the website and once for `/admin/`.
- **Report links are short** (for example `yoursite.netlify.app/r/Ab3dEf9GhJk`). Links you already sent keep working.

## Review videos on the website

The website needs these files in the main folder, next to `index.html`: `reviews.mp4`, `reviews-2.mp4`, `reviews.jpg`, `reviews-2.jpg`, `manifest.webmanifest` and the `icons` folder. They are all in the `basirah-site` folder.

## Voice answers and payment receipts

When a client records a voice answer or uploads a payment receipt, the website sends the file to `/api/upload` (the `upload.mjs` function). It is stored privately in your Netlify site, and the admin plays or shows it from the client's record (`/api/file/...`, the `file.mjs` function). Files are removed when you delete the client. Limit: 5 MB per file.

## Feedback studio (the PDF report writer)

`admin/studio.html` is your Basirah Document Studio, built into the admin area. It uses the same sign-in as the dashboard.

- Open any client in the dashboard, then press **Write feedback report**. The studio opens with their name filled in and their answers (typed and voice) in a side panel, with a Copy button on each.
- Each client has one report. Saving puts it in the studio library and the dashboard then shows **Report drafted**, with **Edit feedback report** and **Download PDF** buttons. The same buttons are in the printable answer summary.
- Deleting a client also deletes their report.
- Translation: if a translation fails, the message now ends with a **Reason:** line (for example a wrong key or no credit). If you add `ANTHROPIC_API_KEY` in Netlify (optionally `TRANSLATE_MODEL`), the studio translates on the server. Without it, it tries the browser's own translator, then the paste-it-yourself option.
- Free translation: if the main translator is missing or fails, the studio switches by itself to a free translator (no key, no cost). It translates plain text, so bold and italic are lost, the wording is basic, and it allows roughly 5,000 characters a day. Read every line before sending.
- The PDF maker loads from the cdnjs website, so the computer needs internet.

## How it works
- The client now sees the consent text first (one language, or Arabic and English side by side), must tick the box to continue, and the date and language of their consent are saved on their record.
- Before contact details, the client reviews all their answers (typed, voice or skipped) and can edit any of them.
- In the dashboard, open a client and choose **Open printable summary** for a clean, readable page of their answers with voice players. Use Print to save it as a PDF.
- The public page footer has an **Admin login** link to `/admin/`.
- A client finishes the assessment. The site still sends the Formspree email exactly as before, and now also sends a copy to `/api/submissions`. If that copy fails, nothing is lost: the email remains the primary record.
- Price is set by the server from the package, so dashboard totals always match what the client was shown.
- Payment must be verified before a report can be started. Verifying starts the 24-hour delivery clock, which drives the Overdue counts.
- Two people editing the same record can not overwrite each other: the second save is refused and the record reloads.
- Earlier submissions that only exist in your email are not imported automatically. Use **Add a submission** to enter them.

## Preview on your own computer
```
npm run dev -- --seed --site ../index.html   # demo data, password "demo"
npm test                                     # checks the rules
```

## Packages, offers and promo codes

**Packages page.** Add as many packages as you like (up to 12). Each has an English and Arabic name and description, a price, an optional ribbon such as "Most popular", a check-list of what is included, and an option to highlight it. Tick "Includes a consultation call" to give its orders the consultation scheduling tools. Packages can be hidden but not deleted, so old orders always keep their name. A live preview shows how the card looks to clients.

**Offers.** Type an offer price and, if you like, an end date. Clients see the normal price crossed out, the offer price, the percentage saved and a live countdown. When the end date passes, the normal price returns by itself. The server always charges the real saved price, never a number sent from the browser.

**Promotions page.**
- *Announcement bar:* a slim bar at the top of the website, with an optional automatic end date. Clients can close it.
- *Promo codes:* percentage or fixed amount, for all packages or chosen ones, with optional start and end dates, a limit of uses, and a switch for whether it can be combined with an offer price. Orders show the code and the discount. Use the link button to copy a website link that fills the code in for the client.
- *Message under the prices:* one reassuring line.

New file: `netlify/functions/promo.mjs` (checks a code). Upload the whole `netlify` folder as usual.

## WhatsApp messages and payment methods
The original QR code option was removed from Settings. Add your own payment methods under "Ways to pay". Until you add one, clients see a temporary QR code so they are never left without a way to pay.

## Share offers on WhatsApp, and manual orders
On the **Packages** page (button on each package) and the **Promotions** page (💬 button on each code), choose Share on WhatsApp. Pick English or Arabic, add the client's first name for a personal greeting, optionally type their number, edit the message, then open WhatsApp or copy it. Links go through the share page, so WhatsApp shows the Basirah logo preview and the code or package is ready when the client lands on the site.

"Record manual order" (formerly "Add a submission") is kept for orders that arrive outside the website, such as during downtime, by WhatsApp, by bank transfer or in person. You pick how it reached you and the note is stored on the order.

## Pictures for packages, offers and promo codes
Each package, each promo code and the announcement bar can have an optional picture. Choose it in the admin; it is cropped to a wide card shape, shrunk and stored on your site (new file `netlify/functions/img.mjs`, upload the whole `netlify` folder).
- **Package picture:** top of the package card on the website and a small thumbnail in the package step. Also the WhatsApp preview when you share that package.
- **Announcement picture:** shown as an offer poster above the packages while the announcement is on.
- **Promo code picture:** shown to the client when they use the code, and as the WhatsApp preview when you share the code.
- A plain site link (the greeting message) always shows the Basirah logo.
Removing a picture only unlinks it; the stored file stays but costs almost nothing.

## Phone numbers: search the country, type only the rest
Every phone field (the website contact step, WhatsApp numbers in Settings, the message box, the share window and manual orders) now has a searchable country picker. Tap it, type part of a country name or code (for example "phil" or "+63"), and choose. Then type only the remaining digits; a leading 0 is dropped for you. Pasting a full international number picks the country automatically. In Arabic, country names show in Arabic.

## Payment step and payment checks

- **Client side:** the payment step shows the amount and an order code (both with Copy buttons), then a big "Take a photo or choose a screenshot" button for the receipt. The receipt is required; the payment reference is optional (you can read it from the receipt).
- **Automatic checks (server):** each new order is checked and may get a yellow "Check" mark in the Submissions list: the same receipt picture used on another order, the same reference used before, an unusual reference (0000, 1234, test...), or no receipt that arrived. Nothing is blocked, you decide.
- **In the client drawer:** a side-by-side view of what the client entered (amount, order code, reference, method, promo) next to the receipt, with Copy buttons. Warnings appear above it, with "Open that order" and "Ask for the receipt" buttons.
- **Reject with a reason:** pick a quick reason or type your own. The reason is saved in the activity log and the "Payment problem" message opens already written for the client, including the reason.
- **Filter:** Submissions, Payment filter, "Needs a closer look" shows pending orders with a warning.

## WhatsApp messages: picture cards and opening WhatsApp

- **Every message carries a picture.** A WhatsApp message itself cannot hold a picture, but its link turns into a card with a title, a line of text and an image. Every message the site and the admin write now ends with a Basirah link (`/s?m=<kind>&l=<en|ar>`), and each kind has its own card: welcome, payment help, assessment received, consultation, payment received, payment problem, delay, report ready, consultation confirmed. The report page and the review page have their own cards too. The pictures are `og-chat.png`, `og-card.png`, `og-check.png`, `og-cal.png`, `og-clock.png`, `og-doc.png` and `og-star.png` in the site root. Cards for packages, promo codes and the announcement keep using the pictures you upload.
- **Opening WhatsApp.** On phones the buttons open the WhatsApp app. On computers they open WhatsApp Web directly, which avoids the desktop app scrambling emoji into question marks. Emoji used are all long-established ones.
- **Wording.** Each message has a bold headline, a short warm body and a clear next step, in English and Arabic. Messages you have already customised in Settings are not changed.

## Free access (free codes, gifts and marking an order as free)

- **Free code:** in Promotions choose “+ Make a free-access code” (or set any code to “Everything: free access”). The client enters it, or opens its link, and skips the payment step. The server decides the price, so a changed browser page cannot get a free order.
- **Limits:** limit of uses, end date, packages it works on, and “One use per person” (same email address or phone number; written differently it is still the same person). A free code with no limit shows a warning.
- **Free orders:** saved as verified straight away, price 0, with a green **Free** tag, so the report steps are open. They are **not revenue**. They are counted separately: Overview card “Free orders”, Growth & revenue “Free orders” and “Given as free access”, and the table “Promo codes and free access” (plus “By campaign”).
- **Gift by hand:** “Record manual order” → tick “This is a free order”.
- **An order that was really a gift but went through payment:** open it, press “This order should be free”, choose a reason. Revenue drops by its amount at once. The old payment details are kept in the order (and “Turn back into a paid order” restores them).
- **Deleting an order** gives its code use back, and that person’s turn.
- Dashboard filter: Submissions → Payment → “Free orders” or “Paid and verified”. CSV export has Free, Promo code, Value given free and Campaign columns.

## Numbers and WhatsApp cards

- The serif heading font draws the digit 1 like a capital I. Digits (and the comma between them) now use the Lora font, built into the files (site, admin and the report studio); letters keep the serif.
- Link cards: `/s?m=…&l=…&v=2`. The `v` number makes WhatsApp fetch the card fresh. Add 1 to it (in `comms.js` and the admin `tplFill`) if you ever change a card picture. Pictures are now under 100 KB (WhatsApp ignores big ones). The card page has complete tags (og:url, secure_url, image type and size, twitter tags) and no longer uses a redirect tag.

## Moving to Supabase + Cloudflare (so deploys stop using Netlify credits)

What changes: the **web pages** are served by Cloudflare Pages (free, unlimited deploys). The **back office** (orders, settings, files, reports) runs as one Supabase function with a Supabase database and file box. Netlify is no longer needed.

Why a relay: Supabase shows web pages as plain text on its own address, so the pages (link cards, report page, review page) pass through a tiny Cloudflare relay that puts the right type back. It is already written (`functions/[[path]].js`).

### Do it in this order
1. **Upload everything to GitHub in ONE go** (the site zip, the update zip, and this package), so Netlify deploys only once. This final Netlify deploy gives the old site an "export" door so your data can be copied.
2. **Supabase** (supabase.com, sign in with GitHub or email):
   - *New project*: any name, a strong database password (save it), region closest to your clients (for example Frankfurt or Mumbai). Wait until it is ready.
   - Left menu **SQL Editor → New query**: paste all of `supabase/schema.sql`, press **Run**.
   - Left menu **Edge Functions → Deploy a new function → Via Editor**. Name it exactly `api`. Delete the sample code, paste all of `supabase/functions/api/bundle.ts`, press **Deploy**.
   - In that function's **Details/Settings**, switch **Verify JWT** (or "Enforce JWT verification") **OFF**.
   - **Edge Functions → Secrets**: add `ADMIN_PASSWORD` (the same password you use now). If you used `ADMIN_SECRET`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` or `TRANSLATE_MODEL` on Netlify, add the same ones here. `MIGRATE_ORIGIN` is only for Netlify (below).
   - Copy the function address: `https://<your-project>.supabase.co/functions/v1/api`.
3. **Cloudflare Pages** (dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git): choose the `basirah-site` repository. Build command: leave empty. Output directory: `/` (or leave empty). Open **Environment variables** and add `SUPABASE_FN_URL` = the function address from step 2. Deploy. You get an address like `https://basirah-site.pages.dev`.
4. **Check**: open `https://<yours>.pages.dev/api/health`. It must say `"ok":true`. If it says `"table":false` run the SQL again; if `"files":false` the bucket was not created (run the SQL again).
5. **Copy your old data**: open `https://<yours>.pages.dev/admin/migrate.html`, type your old Netlify address and your admin password, press **Start copying**. It says "Done" when finished. It can be repeated safely (it only adds or refreshes).
   - If it says the old site does not answer, the Netlify deploy of step 1 is not finished or failed.
   - If it says "Failed to fetch": in Netlify → Site settings → Environment variables add `MIGRATE_ORIGIN` = your pages.dev address, and deploy again (only needed if your address does not end with `.pages.dev`).
6. **Look around**: sign in at `/admin` on the new address, check orders, a receipt picture, a voice answer, and the settings. Send yourself a test order.
7. **Switch your domain** (if you have one) to Cloudflare Pages (Custom domains), then in Netlify **pause or delete** the site so it can no longer use credits. Keep the Netlify site until you are happy.
8. **Keep Supabase awake** (free projects pause after 7 days with no use): create a free account at uptimerobot.com and add an HTTP monitor for `https://<yours>.pages.dev/api/health` every 5 minutes. (Real visitors also keep it awake.)

### What stays the same
All screens, messages, codes, free access, reports, WhatsApp cards. Link cards use the same addresses. Orders, settings and files are copied exactly.

### Free-plan limits to know
Supabase free: 500 MB database, 1 GB files, 5 GB traffic a month, 500,000 function calls a month. Your use is far below this today. Check Supabase → Settings → Usage once a month.

### For developers
`dev/mock-supabase.mjs` is a pretend Supabase; `MOCK_SUPABASE=http://localhost:54321 node dev/server.mjs` runs the whole site on the Supabase store code. Rebuild the single function file with `node supabase/build.mjs` (needs esbuild).
