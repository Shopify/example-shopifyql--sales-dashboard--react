import {useLoaderData, useNavigation} from 'react-router';
import {LineChart, PolarisVizProvider} from '@shopify/polaris-viz';
import '@shopify/polaris-viz/build/esm/styles.css';
import {authenticate} from '../shopify.server';

// [START sales-dashboard.top-products]
const TOP_PRODUCTS_QUERY = `
  query TopProducts {
    shopifyqlQuery(
      query: "FROM sales SHOW product_title, net_sales GROUP BY product_title SINCE -30d ORDER BY net_sales DESC LIMIT 10"
    ) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
    }
  }
`;
// [END sales-dashboard.top-products]

// [START sales-dashboard.query]
const SALES_QUERY = `
  query SalesThisWeek {
    shop {
      currencyCode
    }
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales, orders TIMESERIES day SINCE -7d COMPARE TO previous_period WITH TOTALS ORDER BY day ASC"
    ) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
    }
  }
`;

export async function loader({request}) {
  const {admin} = await authenticate.admin(request);

  // Run both queries together. The dashboard query drives the metric, chart,
  // and detail table, and reads the store's currency for formatting. The
  // top-products query drives the leaderboard.
  const [salesResponse, topProductsResponse] = await Promise.all([
    admin.graphql(SALES_QUERY),
    admin.graphql(TOP_PRODUCTS_QUERY),
  ]);

  const salesData = (await salesResponse.json()).data;
  const topProducts = (await topProductsResponse.json()).data.shopifyqlQuery;

  return {
    sales: salesData.shopifyqlQuery,
    currencyCode: salesData.shop.currencyCode,
    topProducts,
  };
}
// [END sales-dashboard.query]

export default function Index() {
  const {sales, currencyCode, topProducts} = useLoaderData();
  const navigation = useNavigation();

  // [START sales-dashboard.parse-errors]
  // A ShopifyQL query that can't parse returns its problems in parseErrors
  // rather than throwing. Check every query's parseErrors before reading
  // tableData, so one bad query shows a banner instead of a blank page.
  const parseErrors = [...sales.parseErrors, ...topProducts.parseErrors];
  if (parseErrors.length > 0) {
    return (
      <s-page heading="Sales">
        <s-banner heading="Your query couldn't run" tone="critical">
          <s-unordered-list>
            {parseErrors.map((error) => (
              <s-list-item key={error}>{error}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      </s-page>
    );
  }
  // [END sales-dashboard.parse-errors]

  // [START sales-dashboard.read]
  const {columns, rows} = sales.tableData;

  // Read cells by column name, never by position, so reordering the SHOW
  // clause doesn't break the mapping. formatValue turns a null cell into a
  // placeholder, so this accessor returns the raw value.
  const cell = (row, name) => row[name];
  // [END sales-dashboard.read]

  // [START sales-dashboard.format]
  // Every value arrives as a string, so format by the column's dataType. Keep
  // MONEY as a string through formatting to avoid rounding, and parse to a
  // number only where you calculate. Format money in the store's currency,
  // which the query read from the shop.
  const currency = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode,
  });
  const shortDate = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  });

  const formatValue = (value, dataType) => {
    if (value === null) return '—';

    switch (dataType) {
      case 'MONEY':
        return currency.format(value);
      case 'DAY_TIMESTAMP':
        return shortDate.format(new Date(value));
      case 'INTEGER':
        return Number(value).toLocaleString();
      default:
        return String(value);
    }
  };
  // [END sales-dashboard.format]

  // [START sales-dashboard.totals]
  // WITH TOTALS repeats the period total on every row, so read it from the
  // first row by name and keep it as a string for display. COMPARE TO
  // previous_period adds a comparison_total_sales__previous_period column with
  // last week's value for each day. Sum those for last week's total, then
  // compute the change by dividing by last week, skipping it when last week is
  // zero so a new store doesn't show a misleading number.
  const totalSales = rows[0]?.['total_sales__totals'] ?? '0';
  const previousTotal = rows.reduce(
    (sum, row) =>
      sum + Number(row['comparison_total_sales__previous_period'] ?? 0),
    0,
  );
  const percentChange =
    previousTotal === 0
      ? null
      : ((Number(totalSales) - previousTotal) / Math.abs(previousTotal)) * 100;
  // [END sales-dashboard.totals]

  // [START sales-dashboard.states]
  // React Router runs the loader before the first paint, so the initial load
  // never flashes empty. This placeholder covers later navigations that re-run
  // the loader, such as filters you might add.
  if (navigation.state === 'loading') {
    return (
      <s-page heading="Sales, last 7 days">
        <s-section>
          <s-spinner accessibilityLabel="Loading sales" />
        </s-section>
      </s-page>
    );
  }

  // A store with no sales is a valid result, not an error. TIMESERIES fills
  // every day in the range, so an empty period comes back as rows of zeros
  // rather than zero rows. Treat a zero period total as empty.
  if (rows.length === 0 || Number(totalSales) === 0) {
    return (
      <s-page heading="Sales, last 7 days">
        <s-section heading="No sales yet">
          <s-paragraph>
            When this store makes its first sale, the dashboard shows this
            week's total, its daily trend, and the top-selling products.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }
  // [END sales-dashboard.states]

  // [START sales-dashboard.metric]
  // A brand-new store has no earlier sales to compare against, so percentChange
  // is null. Show the badge only when there's a previous period. Keeping the
  // tone in its own const preserves its literal type, so the s-badge tone stays
  // valid if you move this into a TypeScript app.
  const changeTone =
    percentChange !== null && percentChange >= 0 ? 'success' : 'critical';
  const changeLabel =
    percentChange === null
      ? null
      : `${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(1)}% vs last week`;
  // [END sales-dashboard.metric]

  return (
    <s-page heading="Sales, last 7 days">
      {/* [START sales-dashboard.metric] */}
      <s-section heading="Total sales">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-heading>{currency.format(totalSales)}</s-heading>
          {changeLabel ? (
            <s-badge tone={changeTone}>{changeLabel}</s-badge>
          ) : null}
        </s-stack>
      </s-section>
      {/* [END sales-dashboard.metric] */}

      {/* [START sales-dashboard.chart] */}
      <s-section heading="Daily trend">
        <PolarisVizProvider>
          <div style={{height: 320}}>
            <LineChart
              data={[
                {
                  name: 'Total sales',
                  data: rows.map((row) => ({
                    key: row['day'],
                    value: Number(row['total_sales']),
                  })),
                },
              ]}
            />
          </div>
        </PolarisVizProvider>
      </s-section>
      {/* [END sales-dashboard.chart] */}

      {/* [START sales-dashboard.render] */}
      <s-section heading="Daily breakdown">
        <s-table variant="auto">
          <s-table-header-row>
            {columns.map((column) => (
              <s-table-header key={column.name}>
                {column.displayName}
              </s-table-header>
            ))}
          </s-table-header-row>
          <s-table-body>
            {rows.map((row, index) => (
              <s-table-row key={index}>
                {columns.map((column) => (
                  <s-table-cell key={column.name}>
                    {formatValue(cell(row, column.name), column.dataType)}
                  </s-table-cell>
                ))}
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
      {/* [END sales-dashboard.render] */}

      {/* [START sales-dashboard.top-products] */}
      <s-section heading="Top products, last 30 days">
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header>Product</s-table-header>
            <s-table-header>Net sales</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {topProducts.tableData.rows.map((row, index) => (
              <s-table-row key={index}>
                <s-table-cell>{row['product_title']}</s-table-cell>
                <s-table-cell>{currency.format(row['net_sales'])}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
      {/* [END sales-dashboard.top-products] */}
    </s-page>
  );
}
