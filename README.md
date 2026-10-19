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

## Many devices, and the phone app view

- **Any number of devices** can be signed in at once (phones, tablets, computers). Sessions are not counted. Everyone uses the same password. Tick "Keep me signed in" to stay signed in for 30 days on that device.
- **Settings > Your links and phone app** shows the client website link (copy, or share on WhatsApp) and your private admin link.
- **Phone app view:** iPhone, open the link in Safari, Share, **Add to Home Screen**. Android, open in Chrome, the ⋮ menu, **Install app**. It opens full screen with no browser bars. Do this once for the website and once for `/admin/`.
- **Report links are short** (for example `yoursite.netlify.app/r/Ab3dEf9GhJk`). Links you already sent keep working.

## Review videos on the website

The website needs these files in the main folder, next to `index.html`: `reviews.mp4`, `reviews-2.mp4`, `reviews.jpg`, `reviews-2.jpg`, `manifest.webmanifest` and the `icons` folder. They are all in the `basirah-site` folder.

## Feedback studio (the PDF report writer)

`admin/studio.html` is your Basirah Document Studio, built into the admin area. It uses the same sign-in as the dashboard.

- Open any client in the dashboard, then press **Write feedback report**. The studio opens with their name filled in and their answers (typed and voice) in a side panel, with a Copy button on each.
- Each client has one report. Saving puts it in the studio library and the dashboard then shows **Report drafted**, with **Edit feedback report** and **Download PDF** buttons. The same buttons are in the printable answer summary.
- Deleting a client also deletes their report.
- Translation: if you add `ANTHROPIC_API_KEY` in Netlify (optionally `TRANSLATE_MODEL`), the studio translates on the server. Without it, it tries the browser's own translator, then the paste-it-yourself option.
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
