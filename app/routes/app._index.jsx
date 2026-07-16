import {useEffect, useState} from 'react';
import {useLoaderData, useNavigation} from 'react-router';
import {LineChart, PolarisVizProvider} from '@shopify/polaris-viz';
import '@shopify/polaris-viz/build/esm/styles.css';
import {authenticate} from '../shopify.server';

// [START sales-dashboard.top-products]
const TOP_PRODUCTS_QUERY = `
  query TopProducts {
    shopifyqlQuery(
      query: "FROM sales SHOW net_sales GROUP BY TOP 10 product_title SINCE -30d ORDER BY net_sales DESC"
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

  const [salesResponse, topProductsResponse] = await Promise.all([
    admin.graphql(SALES_QUERY),
    admin.graphql(TOP_PRODUCTS_QUERY),
  ]);

  const salesBody = await salesResponse.json();
  const topProductsBody = await topProductsResponse.json();

  // Transport-level problems, such as a missing access scope or ungranted
  // protected customer data access, come back as top-level GraphQL errors with
  // a null data payload. Check for them before reading the results, so the app
  // shows an error instead of crashing.
  const errors = [
    ...(salesBody.errors ?? []),
    ...(topProductsBody.errors ?? []),
  ];
  if (errors.length > 0) {
    throw new Response(errors.map((error) => error.message).join('\n'), {
      status: 500,
    });
  }

  return {
    sales: salesBody.data.shopifyqlQuery,
    currencyCode: salesBody.data.shop.currencyCode,
    topProducts: topProductsBody.data.shopifyqlQuery,
  };
}
// [END sales-dashboard.query]

export default function Index() {
  const {sales, currencyCode, topProducts} = useLoaderData();
  const navigation = useNavigation();

  // [START sales-dashboard.client-only]
  // Polaris Viz reads `window` when it renders, so the chart can't run during
  // server-side rendering. Track when the component has mounted on the client,
  // and render the chart only after that. The rest of the page still renders on
  // the server.
  const [isClient, setIsClient] = useState(false);
  useEffect(() => setIsClient(true), []);
  // [END sales-dashboard.client-only]

  // [START sales-dashboard.parse-errors]
  // A query that can't parse reports problems in parseErrors instead of
  // throwing, so check it before reading tableData.
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

  // Read cells by column name, not by position, so reordering SHOW is safe.
  const cell = (row, name) => row[name];
  // [END sales-dashboard.read]

  // [START sales-dashboard.format]
  // Values arrive as strings, so format by the column's dataType. Keep MONEY
  // as a string to avoid rounding, and format it in the store's currency.
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
  // WITH TOTALS repeats the period total on every row for this period and, with
  // COMPARE TO, for the compared period too. Read both from the first row, then
  // compute the change yourself, guarding divide-by-zero so a new store isn't
  // misleading.
  const totalSales = rows[0]?.['total_sales__totals'] ?? '0';
  const previousTotal = Number(
    rows[0]?.['comparison_total_sales__previous_period__totals'] ?? 0,
  );
  const percentChange =
    previousTotal === 0
      ? null
      : ((Number(totalSales) - previousTotal) / Math.abs(previousTotal)) * 100;
  // [END sales-dashboard.totals]

  // [START sales-dashboard.states]
  if (navigation.state === 'loading') {
    return (
      <s-page heading="Sales, last 7 days">
        <s-section>
          <s-spinner accessibilityLabel="Loading sales" />
        </s-section>
      </s-page>
    );
  }

  // TIMESERIES fills every day in the range, so an empty period returns rows
  // of zeros, not zero rows. Treat a zero period total as empty.
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
  // A brand-new store has no earlier period, so percentChange is null. Show the
  // change badge only when there's a previous period to compare against.
  const changeTone =
    percentChange !== null && percentChange >= 0 ? 'success' : 'critical';
  const changeLabel =
    percentChange === null
      ? null
      : `${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(1)}% vs last week`;
  // [END sales-dashboard.metric]

  // [START sales-dashboard.render]
  // WITH TOTALS and COMPARE TO added __totals and comparison_ columns the
  // metric already uses. Show only the base per-day columns in the table.
  const detailColumns = columns.filter(
    (column) =>
      !column.name.endsWith('__totals') &&
      !column.name.startsWith('comparison_'),
  );
  // [END sales-dashboard.render]

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
        <div style={{height: 320}}>
          {isClient ? (
            <PolarisVizProvider>
              <LineChart
                xAxisOptions={{
                  labelFormatter: (value) => shortDate.format(new Date(value)),
                }}
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
            </PolarisVizProvider>
          ) : null}
        </div>
      </s-section>
      {/* [END sales-dashboard.chart] */}

      {/* [START sales-dashboard.render] */}
      <s-section heading="Daily breakdown">
        <s-table variant="auto">
          <s-table-header-row>
            {detailColumns.map((column) => (
              <s-table-header key={column.name}>
                {column.displayName}
              </s-table-header>
            ))}
          </s-table-header-row>
          <s-table-body>
            {rows.map((row, index) => (
              <s-table-row key={index}>
                {detailColumns.map((column) => (
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
