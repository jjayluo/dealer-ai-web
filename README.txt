DealerAI dealership workspace

The working CRM is served at /app/ by backend/server.mjs. Use Node.js 24.14 or newer.
First-run setup and tests: backend/README.local.md
Backend entry points: backend/README.md

Figma-style HTML prototype

Open locally:
1. Unzip DealerAI_Figma_Style.zip
2. Open index.html in Chrome/Safari

Pages:
- index.html
- inventory.html
- customers.html
- leads.html
- lead-chat.html
- appointments.html
- sales.html
- report.html
- settings.html


V2 adds documentation-based dropdowns, three-dot menus, and field-reference.html.

V3 pages added:
- conversation.html
- add-inventory.html
- add-appointment.html
Buttons on Inventory, Leads, and Appointment pages now link to these pages.

V4 update:
- Rebuilt conversation.html with auto-translation controls
- Added customer/reply language selectors
- Added AI auto-reply toggle
- Added original-language display
- Added AI suggested reply that fills the composer
- Added send-message interaction
- Added customer details and conversation summary panel
