# E-Clips Hair Studio — Site Map & Booking Spec (Developer Hand-off)

Rebuild of [e-clipshairstudio.com](https://www.e-clipshairstudio.com/) — a full-service
hair studio with a stylist team and an on-staff esthetician (haircuts, styling,
pedicures, waxing).

- **Target stack:** Next.js 16 (App Router) + Tailwind 4 — this repo
- **Shareable version of this doc:** published as a Claude artifact (see hand-off thread)

> **Verify before build:** the current site was researched from search snippets
> (direct access was blocked from the build environment). Confirm the exact
> address, phone, hours, staff roster, and service list/prices with the owner or
> the live page before populating content. Items needing confirmation are marked
> **[verify]**.

## Site map

```
/                       Home
├── /services           Services & Pricing        [existing content]
├── /team               Meet the Team             [existing content]
├── /book               Request a Time            [NEW — booking]
│   └── /book/thanks    Request Received          [NEW]
├── /contact            Contact & Hours           [existing content]
├── /gallery            Gallery                   [phase 2]
├── /api/booking-request  POST — booking intake   [NEW]
├── /privacy            Privacy policy            [utility]
└── sitemap.xml · robots.txt · 404                [generated]
```

## Page inventory

| Route | Purpose | Key content & components |
| --- | --- | --- |
| `/` | First impression, route visitors to booking | Hero + primary CTA "Request a Time"; intro; 3–4 featured services; testimonials strip (real quotes exist on current site); hours & location snapshot; persistent header/footer CTA to `/book`. |
| `/services` | Full service menu with pricing | Groups: **Hair** (women's/men's cuts, styling, color) and **Esthetics** (pedicures, waxing). Price table **[verify]**. Each row links to `/book?service=…`. |
| `/team` | Build trust; let clients pick a stylist | Bio cards: photo, name, role (stylist / esthetician), specialties. "Book with [name]" → `/book?stylist=…`. Roster **[verify]**. |
| `/book` | **New:** booking request form | Request-a-time form (spec below). Pre-fills service/stylist from query params. Expectation copy: "We'll confirm your appointment within one business day." |
| `/book/thanks` | Confirmation state | Summary of the request, what happens next, phone number for urgent changes. Reached only after successful POST. |
| `/contact` | Location, hours, direct contact | Address + map embed, click-to-call phone, hours table **[verify]**, secondary link to `/book`. |
| `/gallery` | Portfolio (phase 2) | Photo grid, optionally by category. Don't block launch on this. |

## "Request a Time" booking flow

Request-based, **not** real-time scheduling. The studio confirms every
appointment by hand, so this is a request → confirm flow: no slot inventory, no
double-booking logic, no payment. If the salon later adopts Square/Vagaro/etc.,
`/book` becomes the integration point.

**Flow:** Choose service → Pick stylist (optional, "No preference" default) →
Request times (preferred date + time window, plus an alternate; closed days
unselectable) → Contact info → Submit → salon confirms by phone/email; client
lands on `/book/thanks`.

### Form fields

| Field | Type | Notes |
| --- | --- | --- |
| `service` | select, required | Options come from the same data module as `/services` so the menu never drifts. |
| `stylist` | select, optional | Staff + "No preference" (default). Esthetic services filter to the esthetician. |
| `preferredDate` | date, required | Min: tomorrow. Closed days disabled — drive from an hours config, don't hardcode. |
| `timeWindow` | radio, required | Morning · Midday · Afternoon · Evening (windows, not exact slots). |
| `altDate` / `altTimeWindow` | optional | A second choice halves confirmation back-and-forth. |
| `name`, `phone`, `email` | required | Phone is the salon's preferred confirmation channel; validate client- and server-side. |
| `notes` | textarea, optional | "First visit, hair length, anything your stylist should know." Max 500 chars. |

Anti-spam: honeypot field + basic rate limiting on the API route.

### Data model & API

```ts
// POST /api/booking-request — validate (zod), then email the studio inbox
type BookingRequest = {
  id: string;               // nanoid, quoted in the confirmation email
  service: string;
  stylist?: string;
  preferredDate: string;    // ISO date
  timeWindow: "morning" | "midday" | "afternoon" | "evening";
  altDate?: string;
  altTimeWindow?: string;
  name: string;
  phone: string;
  email: string;
  notes?: string;
  status: "pending" | "confirmed" | "declined"; // managed by the salon, v1 via email reply
  createdAt: string;
};
```

v1 persistence is intentionally minimal: validate, email a formatted request to
the studio (Resend or SMTP — env var `BOOKING_INBOX`), send the client an
acknowledgment copy, redirect to `/book/thanks`. Add a simple store (SQLite/KV)
only if the owner wants history; no admin panel until asked.

### Form states

| State | Behavior |
| --- | --- |
| Validation error | Inline, per-field, on blur and submit; message says how to fix it. |
| Submit in flight | Button disabled with progress label; prevent double-submit. |
| Server error | Keep entered values; show the studio phone as the fallback path. |
| Success | Redirect to `/book/thanks` with the request summary. |

## Build notes

**Technical**

- Next.js 16 App Router — read `node_modules/next/dist/docs/` first; this
  version has breaking changes vs. older conventions (see `AGENTS.md`).
- Services, staff, and hours live in one typed data module
  (`src/lib/site-data.ts`) consumed by pages, the form, and metadata.
- Generate `sitemap.xml` / `robots.txt` via metadata routes; per-page titles +
  `HairSalon` (LocalBusiness) JSON-LD on `/` and `/contact`.
- Mobile-first: click-to-call everywhere the phone appears; booking CTA stays
  reachable in the header on small screens.

**Needed from the owner**

- Final service menu with prices; staff names, roles, photos, bios.
- Confirmed address, phone, email, weekly hours (drives the date picker).
- Inbox for booking requests (`BOOKING_INBOX`) and who replies to them.
- Photos (hero, interior, gallery) and any brand colors/logo.
- Domain/DNS access for launch cutover from the current static site.
