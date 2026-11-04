# SafeGuardian — Real Parent & Adult Application

SafeGuardian uses separate Supabase Auth accounts. The signed-in account role determines the dashboard; there is no insecure Parent/Adult demo switch. The example family names are **Venkatesh (Parent)** and **Keerthana (Adult / child member)**. Enter the real email addresses in the app and create passwords privately there. Do not send passwords in chat.

## Run in VS Code

1. Extract this ZIP.
2. Open the `SafeGuardian` folder in VS Code.
3. Open **Terminal → New Terminal**.
4. Run:
   ```bash
   npm install
   npm run dev
   ```
5. Open the localhost URL printed by Vite (usually `http://localhost:5173`).

The `.env` file is preconfigured with the connected Supabase project URL and browser-safe publishable key. It does not contain a service-role key.

## Connect Venkatesh and Keerthana

1. On Venkatesh's device/browser, choose **Create account**. Enter `Venkatesh`, his email address, and a password; select **Parent / trusted contact**. Confirm the email if Supabase asks.
2. Sign in as Venkatesh. In Overview, invite Keerthana using the exact email address she will use for her account.
3. On Keerthana's device or a separate browser profile, choose **Create account**. Enter `Keerthana`, use that exact invited email, create her own password, and select **Adult / child member**. Confirm the email if asked.
4. Sign in as Keerthana and accept Venkatesh's invitation.
5. Keerthana can create safety plans and check in using **I'm Safe**. Venkatesh can view the linked plans and activity but cannot edit them.

Family invitations are stored in the app; this frontend does not send invitation emails. Venkatesh must tell Keerthana which email address he invited.

## Live location — consent-based

- Keerthana signs in on the device whose location should be shared.
- Open **Privacy & Consent** and turn on **Share my live location with linked parent**.
- Allow location access when the browser asks.
- The browser GPS coordinates, accuracy, and timestamp are stored in `sg_live_locations`. Venkatesh can open the coordinates in Google Maps only after the invitation is accepted and Keerthana has enabled sharing.
- Turning sharing off removes the latest shared coordinate and prevents the parent from reading it.
- Location updates are sent while the SafeGuardian website remains open. This browser-based version does not track in the background after the tab is closed.
- Geolocation requires `localhost` during local development or HTTPS when deployed. The browser/device must have location services enabled.

## Supabase security and capabilities

- Separate email/password accounts and database roles (`parent`, `adult`).
- Parent invitations require the Adult to accept.
- Row Level Security restricts safety plans, activity, profiles, and live location to the owner and accepted family connection.
- The Adult controls location-sharing consent. Parent cannot turn it on.
- Realtime subscriptions refresh linked plans, events, and locations.
- SOS is recorded as an in-app event. SMS, push, and email alerts require a separately configured notification provider.
- Overdue events require the scheduled `pg_cron` job from the earlier migration to be enabled in the Supabase project.

Never add a Supabase `service_role` or secret key to a Vite `.env` file or frontend code.
