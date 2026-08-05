# example-shopifyql--sales-dashboard--react

An embedded Shopify app that answers whether a marketing campaign worked, and then writes the answer back onto the store's own analytics. It's the companion code for the tutorial [Build a campaign performance dashboard](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard).

Shopify Analytics runs in both directions, and this app closes the loop:

1. [App Events](https://shopify.dev/docs/apps/build/app-events/analytics) report what the app did. Fifteen standard events across email, SMS, push, and lead capture, every one tagged with the same `campaign_id`.
2. [ShopifyQL](https://shopify.dev/docs/api/shopifyql) queries those events back, in the same query language as the store's sales, so the funnel and the revenue read side by side.
3. [Annotations](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/analyticsAnnotationCreate) put the verdict on the store's timeline. Every field on an annotation is mutable, so the app writes its marker before the campaign runs and rewrites it afterwards with the result it measured.

## What it does

**Reads sales.** ShopifyQL through the [`shopifyqlQuery`](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/shopifyqlQuery) field, rendered two ways: by reading the structured `tableData` response into Polaris Viz charts, and by embedding a [metric card](https://shopify.dev/docs/api/shopifyql/2026-10/web-components/metric-card) web component that runs its own query from the browser.

**Measures against goals.** Two [analytics targets](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/analyticsTargetCreate), one store-wide and one scoped with a `filters` expression to the product the campaign pushed. Shopify generates a `shopifyqlQuery` for each target, so progress comes from a query the app never wrote, and one aliased GraphQL document measures every target in a single request.

**Reports its own funnel.** Fifteen standard events sent with a `campaign_id` and a `template_id`, queried back with `FROM app_events`. Lead capture and marketing are separate categories in the [standard event registry](https://shopify.dev/docs/apps/build/app-events/analytics/standard-event-registry), and both accept `campaign_id`, so one `WHERE` clause reports the signups that grew the list alongside the sends that followed. Bounces and unsubscribes sit next to opens and clicks, because the stages that go wrong are the ones worth seeing.

**Draws the sequence, not the blast.** A campaign is nine touches over two weeks. Each carries its own `template_id`, so `GROUP BY template_id` returns one row for each send in the order they went out, and the engagement line across them says whether the list was still listening by the last touch. Each channel gets its own funnel chart, and they're deliberately different lengths, because the registry gives email six events, SMS four, and push two.

**Marks the campaign on the store's timeline.** Eight annotations across six types: the campaign, the collection going live, the landing page, the discount, the email, the paid boost, the creator collaboration, and the SMS. The campaign is open-ended and stays open until it's closed. Everything inside it is a point in time. The types span several categories, so [`ANNOTATE`](https://shopify.dev/docs/api/shopifyql/2026-10/syntax/annotate) can filter them apart.

**Rewrites its marker with the outcome.** Closing the campaign re-measures revenue, the target, and the engagement drop on the server, then sends [`analyticsAnnotationUpdate`](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/analyticsAnnotationUpdate) with a new title, a new description, and an end date. The marker goes up reading `Summer launch` and comes down reading `Summer launch: 169% of target`, written from numbers the app measured rather than numbers a person typed.

**Flags its own incidents.** When bounces cross 2% of the send, the app offers to write an `other` annotation naming the rate and the hard and soft split. A deliverability problem is a reason a week underperformed, and the store's charts are where someone looks for that reason months later.

**Leads with something the user didn't ask for.** Five complete weeks of weekly sales for each product, scanned for the longest unbroken run in either direction, with the annotations from those weeks pinned to the points they explain. A product sliding for three weeks straight is the one worth putting at the top of the page.

**Reads the whole timeline, not just its own markers.** The annotations query filters by date window rather than by source or type, so a sale, a theme change, or a Shopify-generated event in the same week shows up next to the app's markers, each labelled with who wrote it. Reading only your own annotations hides the thing that actually moved the numbers.

The queries and the dashboard live in `app/routes/app._index.jsx`. The App Events client is in `app/app-events.server.js`, and the event declarations are in `extensions/app-events/shopify.extension.toml`.

## How it's built

This sample is the [Shopify React Router app template](https://github.com/Shopify/shopify-app-template-react-router), written in JavaScript, with one route added at `app/routes/app._index.jsx`. It sets four access scopes in `shopify.app.toml`, enables Direct API access so the metric card can query from the browser, adds an `analytics_app_events` extension, and adds `@shopify/polaris-viz` for the charts.

For a smaller starting point that covers the ShopifyQL half on its own, see [Build a sales dashboard with the GraphQL Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/build-a-sales-dashboard). Its companion code is on the [`sales-dashboard`](https://github.com/Shopify/example-shopifyql--sales-dashboard--react/tree/sales-dashboard) branch of this repository.

## Requirements

- A [Shopify Partner account](https://www.shopify.com/partners) and a development store.
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) installed.
- Node.js 20.19+ (or 22.12+).
- [Level 2 access to protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data), which `shopifyqlQuery` requires. Approval can take time, so request it early.
- API version `2026-10` or later. Annotations and targets aren't available before it.
- [App Events in Analytics](https://shopify.dev/docs/apps/build/app-events/analytics) access, which is in developer preview and granted to approved apps. The funnel and sequence panels need it. Every other panel works without it.

## Run locally

1. Install dependencies:

   ```shell
   npm install
   ```

2. Start the app. The CLI walks you through connecting a Partner account and a development store, and populates `client_id`, `application_url`, and `redirect_urls` in `shopify.app.toml`:

   ```shell
   npm run dev
   ```

3. Deploy the app configuration so the access scopes, the webhook subscription, and the App Events declarations reach Shopify:

   ```shell
   npm run deploy
   ```

4. Install the app on your development store when the CLI prompts you, then open it from the store's admin.

A deployed version takes a few minutes to reach the shop. Events that arrive before the declarations are live are marked ineligible for analytics on arrival, and that verdict is never revisited, so wait a few minutes after deploying before you report the funnel.

## Fill the dashboard

On a fresh install the store has no campaign records, so the goals, the markers, and the funnel are all empty. Sales, the daily trend, and the product leaderboard render from the store's own order history.

Click **Launch the campaign**. It reports the funnel, writes all eight markers, and sets both goals. The markers and goals show up on the next render. App Events processes asynchronously, so the funnel and sequence panels stay at zero for a few minutes. Reload until they fill in.

Then run the writes that depend on the result:

- **Close the campaign with its result** rewrites the campaign marker with the revenue it earned and sets its end date.
- **Raise the goal** appears on a target that's been met, and moves it to the next round number.
- **Mark this win on analytics** records the win as a `revenue_milestone` annotation, in the operations category rather than among the marketing markers.
- **Put this on the store's charts** appears in a banner when the bounce rate crosses the threshold.
- **Cancel the campaign** removes every marker this app wrote, along with both goals.

Each write re-measures on the server before it commits, so an annotation only lands if the numbers still support it. Open the store's analytics in the Shopify admin after each one to watch it land outside the app. App Events have no delete, so **Cancel the campaign** leaves the funnel numbers in place.

### Point it at your own campaign

The `CAMPAIGN` constant at the top of `app/routes/app._index.jsx` holds the campaign's ID, title, dates, both revenue targets, the bounce alert threshold, and the eight markers. Every query filters on `CAMPAIGN.id`, so a store that has run more than one campaign still gets a dashboard about this one. The send plan the app reports is in `app/app-events.server.js`.

App Events data can't be deleted, and an idempotency key that's already been used is dropped along with its payload. Give each run its own `CAMPAIGN.id` when you change the event payload, or the earlier run's events keep landing in your totals.

Event metrics are scoped to the app that declared them. `FROM app_events` resolves for any app, but its columns only exist for the app whose extension declares those events, so running the funnel query from another app or from the CLI returns `Column Not Found`. Query it from this app.

An event timestamp is a UTC instant, and ShopifyQL buckets it into a day using the shop's timezone. An event stamped `2026-07-22T00:00:00Z` lands on July 21 for a shop in New York, which drops it out of a window that starts on the 22nd. `sendCampaignFunnel` takes the shop's `ianaTimezone` and anchors the campaign to 9am local, so the first send stays inside the window whatever the offset.

## Contributions

This repository is a documentation sample. It doesn't accept issues or contributions. To report a problem with the tutorial, use the feedback control on the [tutorial page](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard).

## License

This sample is released under the [MIT License](./LICENSE.md).
