# example-shopifyql--sales-dashboard--react

A minimal embedded Shopify app that runs a [ShopifyQL](https://shopify.dev/docs/api/shopifyql) query with the GraphQL Admin API and renders the results in the Shopify admin. It's the companion code for the tutorial [Run your first ShopifyQL query](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api).

The app sends two ShopifyQL queries through the [`shopifyqlQuery`](https://shopify.dev/docs/api/admin-graphql/latest/queries/shopifyqlQuery) field, reads the structured `tableData` responses, and checks `parseErrors` before rendering. The dashboard shows a headline total with its week-over-week change, a Polaris Viz trend chart, a daily breakdown table, and a top-products leaderboard, with money formatted in the store's currency and real loading and empty states. The queries live in `app/routes/app._index.jsx`.

## How it's built

This sample is the [Shopify React Router app template](https://github.com/Shopify/shopify-app-template-react-router), written in JavaScript, with one route added at `app/routes/app._index.jsx`. It changes the access scope in `shopify.app.toml` from `write_products` to `read_reports`, and adds `@shopify/polaris-viz` for the trend chart.

## Requirements

- A [Shopify Partner account](https://www.shopify.com/partners) and a development store.
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) installed.
- Node.js 20.19+ (or 22.12+).
- The `read_reports` access scope and [Level 2 access to protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data), which `shopifyqlQuery` requires.

## Run locally

1. Install dependencies:

   ```shell
   npm install
   ```

2. Start the app. The CLI walks you through connecting a Partner account and a development store:

   ```shell
   npm run dev
   ```

3. Install the app on your development store when the CLI prompts you, then open it from the store's admin. The home page shows this week's total sales with the change from last week, a daily trend chart, a breakdown table, and the top-selling products.

## Contributions

This repository is a documentation sample. It doesn't accept issues or contributions. To report a problem with the tutorial, use the feedback control on the [tutorial page](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api).

## License

This sample is released under the [MIT License](./LICENSE.md).
