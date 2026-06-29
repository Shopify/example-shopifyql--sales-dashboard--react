import {useLoaderData} from 'react-router';
import {authenticate} from '../shopify.server';

// [START sales-dashboard.query]
const SALES_QUERY = `
  query SalesLast7Days {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales, orders TIMESERIES day SINCE -7d ORDER BY day ASC"
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

  const response = await admin.graphql(SALES_QUERY);
  const body = await response.json();

  return {shopifyqlQuery: body.data.shopifyqlQuery};
}
// [END sales-dashboard.query]

export default function Index() {
  const {shopifyqlQuery} = useLoaderData();

  // [START sales-dashboard.parse-errors]
  if (shopifyqlQuery.parseErrors.length > 0) {
    return (
      <s-page heading="Sales">
        <s-banner heading="Your query couldn't run" tone="critical">
          <s-unordered-list>
            {shopifyqlQuery.parseErrors.map((error) => (
              <s-list-item key={error}>{error}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      </s-page>
    );
  }
  // [END sales-dashboard.parse-errors]

  // [START sales-dashboard.read]
  const {columns, rows} = shopifyqlQuery.tableData;

  // Read each cell by column name, never by position, so reordering the SHOW
  // clause doesn't break the mapping. Show a placeholder when a cell is null.
  const formatCell = (row, column) => {
    const value = row[column.name];
    return value === null ? '—' : String(value);
  };
  // [END sales-dashboard.read]

  // [START sales-dashboard.render]
  return (
    <s-page heading="Sales, last 7 days">
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
                    {formatCell(row, column)}
                  </s-table-cell>
                ))}
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
  // [END sales-dashboard.render]
}
