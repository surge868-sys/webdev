# E-Clips Hair Studio — Site Map & Booking Spec (Developer Hand-off)

Rebuild of [e-clipshairstudio.com](https://www.e-clipshairstudio.com/) — a full-service
hair studio with a stylist team and an on-staff esthetician (haircuts, styling,
pedicures, waxing).

- **Target stack:** WordPress + Bricks Builder + ACF + Fluent Forms
- **Shareable version of this doc:** published as a Claude artifact (see hand-off thread)

> **Verify before build:** the current site was researched from search snippets
> (direct access was blocked from the build environment). Confirm the exact
> address, phone, hours, staff roster, and service list/prices with the owner or
> the live page before populating content. Items needing confirmation are marked
> **[verify]**.

## Site map

```
/                       Home
├── /services           Services & Pricing (hub)  [existing content]
│   ├── /services/haircuts    Haircuts
│   ├── /services/color       Color & Highlights
│   ├── /services/styling     Styling & Occasions
│   └── /services/esthetics   Esthetics — Pedicures & Waxing
├── /about              About the Studio          [expanded]
├── /team               Meet the Team             [existing content]
├── /book               Request a Time            [NEW — booking]
│   └── /book/thanks    Request Received          [NEW]
├── /contact            Contact & Hours           [existing content]
├── /gallery            Gallery                   [phase 2]
├── (form entries)      Booking intake — Fluent Forms → email + DB   [NEW]
├── /privacy            Privacy policy            [utility]
└── sitemap.xml · robots.txt · 404                [SEO plugin + Bricks error template]
```

## Page inventory

| Route | Purpose | Key content & components |
| --- | --- | --- |
| `/` | First impression, route visitors to booking | Hero + primary CTA "Request a Time"; intro; 3–4 featured services; testimonials strip (real quotes exist on current site); hours & location snapshot; persistent header/footer CTA to `/book`. |
| `/services` | Hub: full menu at a glance | Compact menu of all services with prices, grouped by category — Bricks query loop over the `service` CPT's group taxonomy. Group headers link to detail subpages; each row links to `/book/?service=…`. Prices **[verify]**. |
| `/services/…` | Detail page per service group (×4) | One Bricks template, four term pages: `haircuts`, `color`, `styling`, `esthetics`. Each: intro copy, included services + prices + typical duration, before/after photos, short FAQ (2–3 questions), "Request a Time" CTA pre-filtered to that group. These carry the local SEO weight ("balayage [city]") — own title/meta each. |
| `/about` | The studio's story; conversion warm-up | Owner's story and philosophy, studio photos, what a first visit is like. Links onward to `/team` and `/book`. If the owner wants it personal ("About [name]"), keep the `/about` slug and lead with the owner's bio. Angle **[verify]**. |
| `/team` | Build trust; let clients pick a stylist | Bio cards from the `staff` CPT: photo, name, role (stylist / esthetician), specialties. "Book with [name]" → `/book/?stylist=…`. Roster **[verify]**. |
| `/book` | **New:** booking request form | Fluent Forms request-a-time form (spec below) embedded in the Bricks template. Pre-fills service/stylist from query params. Expectation copy: "We'll confirm your appointment within one business day." |
| `/book/thanks` | Confirmation state | Summary of the request, what happens next, phone number for urgent changes. Redirect target after successful submit. |
| `/contact` | Location, hours, direct contact | Address + map embed, click-to-call phone, hours table **[verify]**, secondary link to `/book`. |
| `/gallery` | Portfolio (phase 2) | Photo grid, optionally by category. Don't block launch on this. |

## "Request a Time" booking flow

Request-based, **not** real-time scheduling. The studio confirms every
appointment by hand, so this is a request → confirm flow: no slot inventory, no
double-booking logic, no payment.

Build it as a **Fluent Forms** form embedded in the Bricks `/book` template
(rather than the native Bricks form element): it stores entries in the
database, supports conditional logic, pre-fills fields from URL query params,
and ships honeypot/rate-limit anti-spam. If the salon later wants true slot
booking, swap in Amelia (or Square/Vagaro) on the same page — the rest of the
site doesn't change.

**Flow:** Choose service → Pick stylist (optional, "No preference" default) →
Request times (preferred date + time window, plus an alternate; closed weekdays
unselectable) → Contact info → Submit → salon confirms by phone/email; client
lands on `/book/thanks`.

### Form fields (Fluent Forms entry)

| Field | Type | Notes |
| --- | --- | --- |
| `service` | select, required | Options from the `service` CPT (small filter snippet, or kept manually in sync) so the form never drifts from `/services`. Pre-filled from `?service=`. |
| `stylist` | select, optional | Staff + "No preference" (default). Esthetic services filter to the esthetician. Pre-filled from `?stylist=`. |
| `preferred_date` | date, required | Min: tomorrow. Disable the studio's closed weekdays in the date field config — update if hours change. |
| `time_window` | radio, required | Morning · Midday · Afternoon · Evening (windows, not exact slots). |
| `alt_date` / `alt_time_window` | optional | A second choice halves confirmation back-and-forth. |
| `name`, `phone`, `email` | required | Phone is the salon's preferred confirmation channel; validate format. |
| `notes` | textarea, optional | "First visit, hair length, anything your stylist should know." Max 500 chars. |

Anti-spam: Fluent Forms honeypot + rate limiting.

### Intake & notifications

On submit: store the entry, email a formatted request to the studio inbox,
send the client an acknowledgment copy, redirect to `/book/thanks`. Entries in
wp-admin double as the request history (lifecycle: unread → read; salon
confirms by phone or email reply) — no custom admin build needed.

Route all notification email through **WP Mail SMTP** (or the host's SMTP);
unreliable mail delivery is the most common failure point for salon booking
forms — send a test request end-to-end before launch.

### Form states

| State | Behavior |
| --- | --- |
| Validation error | Inline, per-field; message says how to fix it. |
| Submit in flight | Button disabled with progress label; prevent double-submit. |
| Server error | Keep entered values; show the studio phone as the fallback path. |
| Success | Redirect to `/book/thanks` with the request summary. |

## Build notes

**WordPress / Bricks structure**

- **Plugin stack:** Bricks (builder) · ACF (custom fields) · Fluent Forms
  (booking + contact) · Rank Math or Yoast (sitemap.xml, robots, schema) ·
  WP Mail SMTP.
- **CPTs:** `service` (group taxonomy, price, duration, description, order),
  `staff` (role, specialties, photo, bookable), `testimonial` (quote, client
  name). Pages render them with Bricks query loops.
- **Service subpages:** one Bricks *taxonomy term* template renders all four
  `/services/<group>` pages — intro copy, photos, and FAQ live as ACF fields on
  the term, so adding a fifth group later is content work, not a new build.
  Register the taxonomy with `rewrite: services/` so term URLs nest under the
  hub. Services becomes a header dropdown listing the four groups.
- **Bricks templates:** global header (persistent "Request a Time" CTA) and
  footer; 404 template; hours & contact info in an ACF options page so footer,
  `/contact`, and schema all read one source.
- SEO plugin outputs LocalBusiness (`HairSalon`) schema on `/` and `/contact`;
  keep the current site's URLs or 301-redirect old paths at cutover.
- Mobile-first: click-to-call everywhere the phone appears; booking CTA stays
  reachable in the header on small screens.

**Needed from the owner**

- Final service menu with prices & durations; staff names, roles, photos, bios.
- About-page material: the studio's story or owner's bio (and whether it should
  read "About the Studio" or "About [name]"); per-service-group photos and 2–3
  FAQ answers each.
- Confirmed address, phone, email, weekly hours (drives the date picker's
  closed days).
- Inbox that receives booking requests, and who replies to them.
- Photos (hero, interior, gallery) and any brand colors/logo.
- Hosting + domain/DNS access for launch cutover from the current static site.
