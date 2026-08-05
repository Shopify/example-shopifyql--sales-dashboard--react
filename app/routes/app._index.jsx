import {Fragment, useEffect, useState} from 'react';
import {useFetcher, useLoaderData, useNavigation} from 'react-router';
import {
  BarChart,
  ComboChart,
  FunnelChartNext,
  LineChart,
  PolarisVizProvider,
} from '@shopify/polaris-viz';
import '@shopify/polaris-viz/build/esm/styles.css';
import '../chart-tooltip.css';
import {authenticate} from '../shopify.server';
import {SEQUENCE, sendCampaignFunnel, shopMorning} from '../app-events.server';

// [START campaign-dashboard.campaign]
// The campaign this dashboard reports on. Edit these to match your own send.
const CAMPAIGN = {
  // The registry types campaign_id as int, so this has to be a number.
  // A string is accepted with a 202 and then silently dropped in validation.
  // Every query below filters on this, so a shop that has run more than one
  // campaign still gets a dashboard about this one.
  id: 4210,
  title: 'Summer launch',
  startDate: '2026-07-22',
  endDate: '2026-08-04',
  revenueTarget: '5000.00',
  // What one product should earn on its own once the campaign has pushed it.
  productTarget: '5000.00',
  // Bounces above this share of the send are worth telling the user about on
  // their own charts, not just inside this app. Two percent is where senders
  // start worrying about their reputation with the inbox providers.
  bounceAlertRate: 0.02,
  // What the user should see on their charts. The campaign is a span that stays
  // open until it ends. Everything inside it is an instant. That's what endedAt
  // separates.
  //
  // A campaign isn't one event, so don't write it as one. Each of these is a
  // separate thing a user might later want to isolate, and each carries a type
  // from a different category so ANNOTATE can filter them apart.
  marks: [
    {
      key: 'campaign',
      type: 'campaign',
      title: 'Summer launch',
      description: 'Summer collection promotion across email, SMS, and push.',
      date: '2026-07-22',
      ranged: true,
    },
    {
      key: 'launch',
      type: 'product_launch',
      title: 'Summer collection live',
      description: 'The summer collection went on sale.',
      date: '2026-07-22',
    },
    {
      key: 'landing',
      type: 'landing_page_launch',
      title: 'Summer landing page live',
      description: 'Campaign page published, linked from every send.',
      date: '2026-07-22',
    },
    {
      key: 'promo',
      type: 'seasonal_promotion',
      title: 'SUMMER15 discount live',
      description: '15% off the summer collection, issued to every new lead.',
      date: '2026-07-22',
    },
    {
      key: 'email',
      type: 'campaign',
      title: 'Summer launch email',
      description: 'Announced the summer collection to the full list.',
      date: '2026-07-22',
    },
    {
      key: 'ads',
      type: 'ad_spend_change',
      title: 'Paid boost on the summer collection',
      description: 'Daily paid spend tripled behind the campaign creative.',
      date: '2026-07-24',
    },
    {
      key: 'creator',
      type: 'influencer_collaboration',
      title: 'Creator drop with @summerstudio',
      description: 'Sponsored post and story series for the collection.',
      date: '2026-07-27',
    },
    {
      key: 'sms',
      type: 'campaign',
      title: 'Summer launch SMS reminder',
      description: 'Follow-up to subscribers who had not clicked.',
      date: '2026-07-29',
    },
  ],
};

const WINDOW = `SINCE ${CAMPAIGN.startDate} UNTIL ${CAMPAIGN.endDate}`;
// [END campaign-dashboard.campaign]

// [START campaign-dashboard.annotate-clause]
// ANNOTATE takes `category.type`, while the GraphQL Admin API takes the bare
// type. Map one to the other here so the overlay stays in sync with whatever
// this app actually writes. The two types at the bottom are never planned. The
// app writes them from what it measures, after the campaign has run.
const CATEGORIES = {
  campaign: 'marketing_events',
  product_launch: 'product_events',
  landing_page_launch: 'online_store_events',
  seasonal_promotion: 'discount_events',
  ad_spend_change: 'marketing_events',
  influencer_collaboration: 'marketing_events',
  revenue_milestone: 'operation_events',
  other: 'custom_events',
};

const ANNOTATE_CLAUSE = [
  ...new Set(
    [...CAMPAIGN.marks.map((mark) => mark.type), 'revenue_milestone', 'other']
      .map((type) => `${CATEGORIES[type]}.${type}`),
  ),
].join(', ');
// [END campaign-dashboard.annotate-clause]

// [START campaign-dashboard.query]
const SALES_QUERY = `
  query CampaignSales {
    shop {
      id
      currencyCode
      # ShopifyQL buckets a TIMESERIES into days using this timezone, not UTC.
      ianaTimezone
    }
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales, orders TIMESERIES day ${WINDOW} COMPARE TO previous_period WITH TOTALS ORDER BY day ASC"
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
// [END campaign-dashboard.query]

// [START campaign-dashboard.top-products]
const TOP_PRODUCTS_QUERY = `
  query CampaignTopProducts {
    shopifyqlQuery(
      query: "FROM sales SHOW net_sales GROUP BY TOP 10 product_title ${WINDOW} ORDER BY net_sales DESC"
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
// [END campaign-dashboard.top-products]

// [START campaign-dashboard.annotation-read]
// analyticsAnnotations hangs off Shop, not the query root. Filter terms are
// space-separated ANDs over the documented filter fields.
//
// Filter by window, not by source or type. Reading only your own markers hides
// the reason a campaign over- or under-performed: a sale that ran the same
// week, a theme change, a Shopify-generated event. Everything in the window is
// context, and createdByApp tells you which ones are yours.
const ANNOTATIONS_QUERY = `
  query CampaignAnnotations {
    # Your own app's ID, so you can tell your markers from another app's
    # without matching on the title.
    currentAppInstallation {
      app {
        id
      }
    }
    shop {
      analyticsAnnotations(
        first: 50
        sortKey: STARTED_AT
        query: "started_at:>=${CAMPAIGN.startDate} started_at:<=${CAMPAIGN.endDate}"
      ) {
        nodes {
          id
          type
          title
          description
          startedAt
          endedAt
          source
          # Null when Shopify generated the annotation.
          createdByApp {
            id
            title
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;
// [END campaign-dashboard.annotation-read]

// [START campaign-dashboard.target-read]
// A target is a goal plus the query that measures it. `shopifyqlQuery` is
// generated by Shopify from the metric, the dates, and the filters, so progress
// never needs a query of your own. Ask for it and run what comes back.
const TARGETS_QUERY = `
  query CampaignTargets {
    analyticsTargets(first: 10, query: "start_date:${CAMPAIGN.startDate}") {
      nodes {
        id
        name
        metric
        expectedValue
        currencyCode
        startDate
        endDate
        # Narrows what the target measures. Absent for a store-wide goal.
        filters
        # The ready-made progress query for this target's metric, dates, and
        # filters. Run it through shopifyqlQuery to get the current value.
        shopifyqlQuery
      }
    }
  }
`;
// [END campaign-dashboard.target-read]

// [START campaign-dashboard.target-progress]
// Each target carries its own query, so measuring five targets could be five
// round trips. Alias them into one document instead: `shopifyqlQuery` is a
// plain field, and a GraphQL document can select it as many times as it needs.
function progressQuery(targets) {
  const fields = targets
    .map(
      (target, index) =>
        `t${index}: shopifyqlQuery(query: ${JSON.stringify(target.shopifyqlQuery)}) {
          tableData { rows }
          parseErrors
        }`,
    )
    .join('\n');
  return `query TargetProgress {\n${fields}\n}`;
}

// The generated query selects exactly one metric, so the single row it returns
// has exactly one value. Read it without knowing the metric's name.
function progressValue(result) {
  if (!result || result.parseErrors?.length) return null;
  const row = result.tableData?.rows?.[0];
  if (!row) return 0;
  return Number(Object.values(row)[0] ?? 0);
}
// [END campaign-dashboard.target-progress]

// [START campaign-dashboard.app-events-query]
// Each column here exists only because the extension declares the matching
// standard event. On a shop without App Events access the whole GraphQL request
// errors, so this runs through runOptional and stays out of the error banner.
//
// Lead capture and marketing are separate registry categories, and metrics from
// both can share a SHOW clause. The dataset is the shop's app data.
const FUNNEL_METRICS = [
  'forms_submitted',
  'leads_captured',
  'incentives_issued',
  'emails_sent',
  'emails_delivered',
  'emails_opened',
  'email_clicks',
  'emails_bounced',
  'email_unsubscribes',
  'sms_messages_sent',
  'sms_messages_delivered',
  'sms_clicks',
  'sms_unsubscribes',
  'push_notifications_sent',
  'push_notifications_opened',
].join(', ');

const APP_EVENTS_QUERY = `
  query CampaignFunnel {
    shopifyqlQuery(
      query: "FROM app_events SHOW ${FUNNEL_METRICS} WHERE campaign_id = ${CAMPAIGN.id} TIMESERIES day ${WINDOW} ORDER BY day ASC"
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
// [END campaign-dashboard.app-events-query]

// [START campaign-dashboard.sequence-query]
// Each touch carries its own template_id, so grouping by it returns one row for
// each send. A template belongs to one channel, so metrics from all three can
// share a SHOW clause and each row fills only its own channel's columns.
// Attribute dimensions reach back 30 days, so this can't use the campaign
// window the way the funnel query does.
const SEQUENCE_METRICS = [
  'emails_sent',
  'emails_delivered',
  'emails_opened',
  'email_unsubscribes',
  'sms_messages_sent',
  'sms_messages_delivered',
  'sms_clicks',
  'sms_unsubscribes',
  'push_notifications_sent',
  'push_notifications_opened',
].join(', ');

const SEQUENCE_QUERY = `
  query CampaignSequence {
    shopifyqlQuery(
      query: "FROM app_events SHOW ${SEQUENCE_METRICS} WHERE campaign_id = ${CAMPAIGN.id} GROUP BY template_id SINCE -29d UNTIL today ORDER BY template_id ASC"
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
// [END campaign-dashboard.sequence-query]

// [START campaign-dashboard.bounce-query]
// Read back by the attribute that says why a bounce happened. A hard bounce is
// a dead address the user should drop from the list. A soft one is temporary.
// The app runs this before it writes an incident annotation, so the text on the
// user's chart comes from measured data rather than from the browser.
const BOUNCE_QUERY = `
  query CampaignBounces {
    shopifyqlQuery(
      query: "FROM app_events SHOW emails_bounced WHERE campaign_id = ${CAMPAIGN.id} GROUP BY recipient_status SINCE -29d UNTIL today ORDER BY emails_bounced DESC"
    ) {
      tableData {
        columns {
          name
        }
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.bounce-query]

// [START campaign-dashboard.top-product-id]
// The products table shows titles, because that's what a person reads. A target
// filter needs the ID, because a title can be edited out from under it.
const TOP_PRODUCT_ID_QUERY = `
  query CampaignWinner {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales GROUP BY product_id, product_title ${WINDOW} ORDER BY total_sales DESC LIMIT 1"
    ) {
      tableData {
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.top-product-id]

// [START campaign-dashboard.insight-query]
// startOfWeek/endOfWeek bound this to five complete weeks. UNTIL today ends
// mid-week, and a two-day bucket beside a seven-day one reads as a collapse.
//
// OVERALL ranks across the whole window. Without it the top five are re-picked
// every week, so a product that slips to sixth vanishes from that week and
// reads the same as a week with no sales. ONLY drops the Other bucket.
const INSIGHT_QUERY = `
  query CampaignInsight {
    shopifyqlQuery(
      query: "FROM sales SHOW gross_sales TIMESERIES week GROUP BY ONLY TOP 5 product_title OVERALL SINCE startOfWeek(-5w) UNTIL endOfWeek(-1w) ORDER BY week ASC"
    ) {
      tableData {
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.insight-query]

// [START campaign-dashboard.target]
const TARGET_CREATE = `
  mutation CreateCampaignTarget($input: AnalyticsTargetCreateInput!) {
    analyticsTargetCreate(input: $input) {
      analyticsTarget {
        id
        name
        metric
        expectedValue
        filters
        shopifyqlQuery
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// Raising a goal you've already beaten is the point of an editable target.
// Only the fields you pass change, so this leaves the metric and filters alone.
const TARGET_UPDATE = `
  mutation RaiseCampaignTarget($id: ID!, $input: AnalyticsTargetUpdateInput!) {
    analyticsTargetUpdate(id: $id, input: $input) {
      analyticsTarget {
        id
        name
        expectedValue
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const TARGETS_DELETE = `
  mutation DeleteCampaignTargets($ids: [ID!]!) {
    analyticsTargetsDelete(ids: $ids) {
      deletedIds
      userErrors {
        field
        message
      }
    }
  }
`;
// [END campaign-dashboard.target]

// [START campaign-dashboard.annotation-create]
const ANNOTATION_CREATE = `
  mutation CreateCampaignAnnotation($input: AnalyticsAnnotationCreateInput!) {
    analyticsAnnotationCreate(input: $input) {
      analyticsAnnotation {
        id
        type
        title
        startedAt
        endedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;
// [END campaign-dashboard.annotation-create]

// [START campaign-dashboard.annotation-update]
// Every field on an annotation is mutable, and only the fields you pass are
// changed. That's what lets a marker written before the campaign ran be
// rewritten afterwards with what actually happened.
const ANNOTATION_UPDATE = `
  mutation CloseCampaignAnnotation($id: ID!, $input: AnalyticsAnnotationUpdateInput!) {
    analyticsAnnotationUpdate(id: $id, input: $input) {
      analyticsAnnotation {
        id
        title
        description
        startedAt
        endedAt
        updatedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;
// [END campaign-dashboard.annotation-update]

// [START campaign-dashboard.annotation-delete]
const ANNOTATION_DELETE = `
  mutation DeleteCampaignAnnotation($id: ID!) {
    analyticsAnnotationDelete(id: $id) {
      deletedId
      userErrors {
        field
        message
      }
    }
  }
`;
// [END campaign-dashboard.annotation-delete]

// [START campaign-dashboard.optional-query]
const emptyTable = {tableData: {columns: [], rows: []}, parseErrors: []};

// A query for a dataset the shop can't reach fails the whole GraphQL request
// rather than returning parseErrors, so isolate it from the ones that must run.
async function runOptional(admin, query) {
  try {
    const body = await (await admin.graphql(query)).json();
    if (body.errors?.length) {
      return {...emptyTable, unavailable: body.errors[0].message};
    }
    const result = body.data?.shopifyqlQuery;
    // A parse error returns tableData: null, so normalize before callers read
    // columns or rows off it.
    return {
      tableData: result?.tableData ?? emptyTable.tableData,
      parseErrors: result?.parseErrors ?? [],
      unavailable: null,
    };
  } catch (error) {
    return {...emptyTable, unavailable: error.message};
  }
}
// [END campaign-dashboard.optional-query]

// [START campaign-dashboard.sequence-read]
// Which metrics each channel reports, and what counts as engagement on it. The
// registry gives push no delivery receipt, so what a push reached is what it
// sent, and there's no unsubscribe to report at all.
const CHANNEL_METRICS = {
  email: {
    sent: 'emails_sent',
    reached: 'emails_delivered',
    engaged: 'emails_opened',
    lost: 'email_unsubscribes',
    action: 'opened',
  },
  sms: {
    sent: 'sms_messages_sent',
    reached: 'sms_messages_delivered',
    engaged: 'sms_clicks',
    lost: 'sms_unsubscribes',
    action: 'clicked',
  },
  push: {
    sent: 'push_notifications_sent',
    reached: 'push_notifications_sent',
    engaged: 'push_notifications_opened',
    action: 'opened',
  },
};

// Join the analytics rows back to the app's own send plan. Analytics knows the
// template_id and nothing else about it. The app knows what it sent under that
// id, and the join is what turns a set of numbers into a sequence that has an
// order and a name.
function readSequence(table) {
  const rows = table?.tableData?.rows ?? [];
  return SEQUENCE.map((touch) => {
    const row = rows.find(
      (candidate) => Number(candidate['template_id']) === touch.template,
    );
    if (!row) return null;

    const metrics = CHANNEL_METRICS[touch.channel];
    const value = (metric) => (metric ? Number(row[metric] ?? 0) : 0);
    const sent = value(metrics.sent);
    if (sent === 0) return null;

    const reached = value(metrics.reached);
    const engaged = value(metrics.engaged);
    return {
      name: touch.name,
      channel: touch.channel,
      action: metrics.action,
      sent,
      reached,
      engaged,
      lost: value(metrics.lost),
      // Each touch is scored against its own reach, so a 20-person SMS isn't
      // measured against the size of the email list.
      rate: reached > 0 ? (engaged / reached) * 100 : 0,
    };
  }).filter(Boolean);
}
// [END campaign-dashboard.sequence-read]

// [START campaign-dashboard.outcome-text]
// Annotation text is capped at 75 characters for the title and 150 for the
// description. Text you generate has to be clamped, not assumed short.
const clamp = (value, max) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const sumColumn = (table, metric) =>
  table.tableData.rows.reduce((total, row) => total + Number(row[metric] ?? 0), 0);

// Read the app's own funnel back and decide whether the send went badly enough
// to be worth putting on the user's charts. The two tables come from
// app_events, so this is the app grading its own work.
function detectIncident(funnel, bounces) {
  const sent = sumColumn(funnel, 'emails_sent');
  const bounced = sumColumn(funnel, 'emails_bounced');
  if (sent === 0 || bounced / sent < CAMPAIGN.bounceAlertRate) return null;

  // Name the split. A hard bounce is an address to drop from the list, and a
  // soft one is temporary, so the two call for different responses.
  const split = bounces.tableData.rows
    .filter((row) => row['recipient_status'])
    .map(
      (row) =>
        `${row['emails_bounced']} ${String(row['recipient_status']).replace('_', ' ')}`,
    )
    .join(', ');

  const rate = ((bounced / sent) * 100).toFixed(1);
  const threshold = CAMPAIGN.bounceAlertRate * 100;

  return {
    rate,
    title: clamp(`Deliverability drop on the ${CAMPAIGN.title} email`, 75),
    description: clamp(
      `${rate}% of the send bounced, over the ${threshold}% alert threshold.${split ? ` ${split}.` : ''}`,
      150,
    ),
  };
}

// Measure the campaign, then say what it did. The marker written before the
// send described a plan. This is the sentence that replaces it.
function outcomeText(revenue, target, sequence, money) {
  const percent = target > 0 ? Math.round((revenue / target) * 100) : null;

  const sentences = [
    target > 0
      ? `${money.format(revenue)} against a ${money.format(target)} target.`
      : `${money.format(revenue)} in sales.`,
  ];
  // What the sequence cost the list is the part worth reading next time the
  // store plans one. A total says the campaign worked. This says how hard it
  // had to push to get there.
  const [first] = sequence;
  const last = sequence.at(-1);
  if (first && last !== first) {
    sentences.push(
      `Engagement ${last.rate >= first.rate ? 'rose' : 'fell'} from ${Math.round(first.rate)}% to ${Math.round(last.rate)}% over ${sequence.length} touches.`,
    );
  }

  return {
    title: clamp(
      percent === null
        ? `${CAMPAIGN.title}: ${money.format(revenue)}`
        : `${CAMPAIGN.title}: ${percent}% of target`,
      75,
    ),
    description: clamp(sentences.join(' '), 150),
  };
}
// [END campaign-dashboard.outcome-text]

// [START campaign-dashboard.insight]
// Turn the weekly rows into the one sentence worth leading with. A product on a
// multi-week run is the thing a user wants to know the moment they open the
// app, and the annotations in the same window are the answer to why.
function findInsight(weekly) {
  const byProduct = new Map();
  for (const row of weekly.tableData.rows) {
    const title = row['product_title'];
    if (!title) continue;
    if (!byProduct.has(title)) byProduct.set(title, new Map());
    byProduct.get(title).set(row['week'], Number(row['gross_sales'] ?? 0));
  }

  // Build the axis by stepping 7 days rather than from the weeks the rows
  // mention. TIMESERIES returns no row for a week where nothing sold, so a quiet
  // week disappears and two non-adjacent weeks get compared as though they
  // weren't. OVERALL is what makes a missing row safe to read as a zero.
  const present = [
    ...new Set(weekly.tableData.rows.map((row) => row['week'])),
  ].sort();
  if (present.length < 2) return null;

  const weeks = [];
  for (
    let week = new Date(`${present[0]}T00:00:00Z`);
    week <= new Date(`${present.at(-1)}T00:00:00Z`);
    week.setUTCDate(week.getUTCDate() + 7)
  ) {
    weeks.push(week.toISOString().slice(0, 10));
  }

  let best = null;
  for (const [title, sales] of byProduct) {
    const series = weeks.map((week) => sales.get(week) ?? 0);
    const last = series.length - 1;

    // Count back from the most recent week for as long as the direction holds.
    // A "3rd week up" needs three rising weeks, not three rows. A run down is
    // worth surfacing too, because that's the one the user has to act on.
    const rising = series[last] > series[last - 1];
    if (series[last] === series[last - 1]) continue;

    let streak = 1;
    while (
      streak < series.length &&
      (rising
        ? series[last - streak + 1] > series[last - streak]
        : series[last - streak + 1] < series[last - streak])
    ) {
      streak += 1;
    }

    const latest = series[last];
    const first = series[last - streak + 1];
    const growth =
      first > 0 ? Math.round(((latest - first) / first) * 100) : null;

    // Rank by the length of the run, then by how much money moved, so a long
    // run beats a big one-week jump and a $4,000 swing beats a $40 one.
    const swing = Math.abs(latest - first);
    if (
      !best ||
      streak > best.streak ||
      (streak === best.streak && swing > best.swing)
    ) {
      best = {
        title,
        streak,
        rising,
        latest,
        first,
        growth,
        swing,
        series,
        weeks,
      };
    }
  }
  return best;
}

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th'];
const ordinal = (n) => ORDINALS[n] ?? `${n}th`;
// [END campaign-dashboard.insight]

export async function loader({request}) {
  const {admin} = await authenticate.admin(request);

  // [START campaign-dashboard.locale]
  // The admin sends the user's locale as a request parameter. Pass it through
  // the loader so Intl formats identically on the server and in the browser.
  const locale = new URL(request.url).searchParams.get('locale') ?? 'en';
  // [END campaign-dashboard.locale]

  const [
    salesBody,
    topProductsBody,
    annotationsBody,
    targetsBody,
    weeklyBody,
    appEvents,
    creatives,
    bounces,
  ] = await Promise.all([
    admin.graphql(SALES_QUERY).then((response) => response.json()),
    admin.graphql(TOP_PRODUCTS_QUERY).then((response) => response.json()),
    admin.graphql(ANNOTATIONS_QUERY).then((response) => response.json()),
    admin.graphql(TARGETS_QUERY).then((response) => response.json()),
    admin.graphql(INSIGHT_QUERY).then((response) => response.json()),
    runOptional(admin, APP_EVENTS_QUERY),
    runOptional(admin, SEQUENCE_QUERY),
    runOptional(admin, BOUNCE_QUERY),
  ]);

  // shopifyqlQuery needs read_reports plus Level 2 protected customer data
  // access. Without either, the field errors instead of returning parseErrors.
  if (!salesBody.data?.shopifyqlQuery) {
    return {
      campaign: CAMPAIGN,
      locale,
      fatal:
        salesBody.errors?.[0]?.message ??
        'shopifyqlQuery returned no data. Check read_reports and Level 2 protected customer data access.',
    };
  }

  // [START campaign-dashboard.measure-targets]
  // A second round trip, because the queries to run come from the first one.
  // All of them go in a single document, so the cost is one request whatever
  // the number of targets.
  const targetNodes = targetsBody.data?.analyticsTargets?.nodes ?? [];
  const measurable = targetNodes.filter((target) => target.shopifyqlQuery);
  const progress = measurable.length
    ? (await (await admin.graphql(progressQuery(measurable))).json()).data ?? {}
    : {};

  const targets = targetNodes.map((target) => {
    const index = measurable.indexOf(target);
    const actual = index === -1 ? null : progressValue(progress[`t${index}`]);
    const expected = Number(target.expectedValue);
    return {
      ...target,
      actual,
      // A target with a filter Shopify never validated can still generate a
      // query that fails, so a null here means "couldn't measure", not "zero".
      percent:
        actual === null || expected <= 0
          ? null
          : Math.round((actual / expected) * 100),
      queryError: index === -1 ? null : progress[`t${index}`]?.parseErrors?.[0] ?? null,
    };
  });
  // [END campaign-dashboard.measure-targets]

  return {
    campaign: CAMPAIGN,
    locale,
    fatal: null,
    sales: salesBody.data.shopifyqlQuery,
    shopId: salesBody.data.shop.id,
    currencyCode: salesBody.data.shop.currencyCode,
    timeZone: salesBody.data.shop.ianaTimezone,
    topProducts: topProductsBody.data?.shopifyqlQuery ?? emptyTable,
    // A missing scope fails these fields to null rather than throwing, so fall
    // back to empty instead of crashing the whole dashboard.
    annotations: annotationsBody.data?.shop?.analyticsAnnotations?.nodes ?? [],
    annotationsError: annotationsBody.errors?.[0]?.message ?? null,
    appId: annotationsBody.data?.currentAppInstallation?.app?.id ?? null,
    targets,
    insight: findInsight(weeklyBody.data?.shopifyqlQuery ?? emptyTable),
    // How many of the last five weeks had any sale at all. Lets the empty state
    // name the reason instead of just reporting that there's no insight.
    insightWeeks: new Set(
      (weeklyBody.data?.shopifyqlQuery ?? emptyTable).tableData.rows.map(
        (row) => row['week'],
      ),
    ).size,
    appEvents,
    creatives,
    // The join to the app's own send plan happens here rather than in the
    // component, because the plan lives in a server-only module.
    sequence: readSequence(creatives),
    bounces,
    incident: detectIncident(appEvents, bounces),
  };
}

export async function action({request}) {
  const {admin} = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get('intent');
  // Annotations are instants, and the store's charts place them by the shop's
  // timezone. Resolve every marker date the same way the events are stamped, so
  // a marker can't land on the day before the thing it marks.
  const markedAt = (date) =>
    new Date(shopMorning(date, formData.get('timeZone'))).toISOString();

  // [START campaign-dashboard.store-target]
  // The goal the whole campaign is judged on. `name` is required, and leaving
  // it out fails schema validation.
  const createStoreTarget = async () => {
    const response = await admin.graphql(TARGET_CREATE, {
      variables: {
        input: {
          name: `${CAMPAIGN.title} revenue target`,
          metric: 'total_sales',
          expectedValue: CAMPAIGN.revenueTarget,
          startDate: CAMPAIGN.startDate,
          endDate: CAMPAIGN.endDate,
        },
      },
    });
    return (await response.json()).data.analyticsTargetCreate;
  };
  // [END campaign-dashboard.store-target]

  // [START campaign-dashboard.product-target]
  // A store-wide goal can't tell you whether the product you promoted is the
  // one that grew. Rank the products on the server, then scope a second target
  // to whichever one the campaign actually moved.
  const createProductTarget = async () => {
    const ranked = await runOptional(admin, TOP_PRODUCT_ID_QUERY);
    const winner = ranked.tableData?.rows?.[0];
    if (!winner) {
      return {
        userErrors: [
          {message: 'No product sales in the window, so the scoped goal was skipped.'},
        ],
      };
    }

    const response = await admin.graphql(TARGET_CREATE, {
      variables: {
        input: {
          name: `${winner['product_title']} after ${CAMPAIGN.title}`,
          metric: 'total_sales',
          expectedValue: CAMPAIGN.productTarget,
          // Filters are ShopifyQL expressions, not GraphQL. product_id is a
          // number, so quoting it fails at query time with "Enter a number
          // only" rather than at create time.
          filters: `product_id = ${winner['product_id']}`,
          startDate: CAMPAIGN.startDate,
          endDate: CAMPAIGN.endDate,
        },
      },
    });

    return (await response.json()).data.analyticsTargetCreate;
  };
  // [END campaign-dashboard.product-target]

  // [START campaign-dashboard.raise-target]
  // A goal that's already been beaten stops being a goal. Round the measured
  // value up to the next round number and make that the new one.
  if (intent === 'raise-target') {
    const actual = Number(formData.get('actual'));
    const step = Math.max(1000, 10 ** (Math.floor(Math.log10(actual)) - 1));
    const raised = String(Math.ceil(actual / step) * step);

    const response = await admin.graphql(TARGET_UPDATE, {
      variables: {
        id: formData.get('targetId'),
        input: {expectedValue: raised},
      },
    });

    const result = (await response.json()).data.analyticsTargetUpdate;
    return {intent, userErrors: result.userErrors, raised};
  }
  // [END campaign-dashboard.raise-target]

  // One write for each mark. endedAt does the work: omitted for the sends,
  // which happened at a moment, and null for the campaign, which is still
  // running.
  const writeMarks = async () => {
    const results = [];
    for (const mark of CAMPAIGN.marks) {
      const response = await admin.graphql(ANNOTATION_CREATE, {
        variables: {
          input: {
            // Bare type value. The dotted marketing_events.campaign form is for
            // the ANNOTATE clause only.
            type: mark.type,
            title: mark.title,
            description: mark.description,
            startedAt: markedAt(mark.date),
            ...(mark.ranged ? {endedAt: null} : {}),
          },
        },
      });
      results.push((await response.json()).data.analyticsAnnotationCreate);
    }
    return results;
  };

  // [START campaign-dashboard.close-with-outcome]
  // Closing a campaign is the app's last chance to say what it was worth.
  // Measure first, then write the result over the plan, in the same mutation
  // that sets the end date.
  if (intent === 'close-annotation') {
    const [salesBody, targetsBody, creatives] = await Promise.all([
      admin.graphql(SALES_QUERY).then((response) => response.json()),
      admin.graphql(TARGETS_QUERY).then((response) => response.json()),
      runOptional(admin, SEQUENCE_QUERY),
    ]);

    const money = new Intl.NumberFormat(
      new URL(request.url).searchParams.get('locale') ?? 'en',
      {style: 'currency', currency: salesBody.data.shop.currencyCode},
    );

    const {title, description} = outcomeText(
      Number(
        salesBody.data.shopifyqlQuery.tableData.rows[0]?.['total_sales__totals'] ??
          0,
      ),
      // The store-wide goal, which is the one without a filter narrowing it to
      // a single product.
      Number(
        targetsBody.data?.analyticsTargets?.nodes?.find(
          (node) => !node.filters,
        )?.expectedValue ?? 0,
      ),
      readSequence(creatives),
      money,
    );

    const response = await admin.graphql(ANNOTATION_UPDATE, {
      variables: {
        id: formData.get('annotationId'),
        input: {endedAt: markedAt(CAMPAIGN.endDate), title, description},
      },
    });

    const result = (await response.json()).data.analyticsAnnotationUpdate;
    return {
      intent,
      userErrors: result.userErrors,
      created: result.analyticsAnnotation,
    };
  }
  // [END campaign-dashboard.close-with-outcome]

  // [START campaign-dashboard.flag-incident]
  // The app read its own funnel, found a problem, and puts it on the user's
  // charts next to the sales it affected. Re-run the detection here rather than
  // trusting a rate posted from the browser.
  if (intent === 'flag-incident') {
    const [funnel, bounces] = await Promise.all([
      runOptional(admin, APP_EVENTS_QUERY),
      runOptional(admin, BOUNCE_QUERY),
    ]);

    const incident = detectIncident(funnel, bounces);
    if (!incident) {
      return {
        intent,
        userErrors: [
          {message: 'The bounce rate is back under the threshold. Nothing to flag.'},
        ],
      };
    }

    const response = await admin.graphql(ANNOTATION_CREATE, {
      variables: {
        input: {
          // Not a campaign and not a launch. `other` is the type for something
          // that happened and moved the numbers.
          type: 'other',
          title: incident.title,
          description: incident.description,
          startedAt: markedAt(CAMPAIGN.startDate),
        },
      },
    });

    const result = (await response.json()).data.analyticsAnnotationCreate;
    return {
      intent,
      userErrors: result.userErrors,
      created: [result.analyticsAnnotation],
    };
  }
  // [END campaign-dashboard.flag-incident]

  // [START campaign-dashboard.milestone]
  // Beating a goal is a thing that happened to the business, so record it as
  // one. `revenue_milestone` puts it in the operations category rather than
  // among the marketing markers, which keeps it out of a campaign ANNOTATE
  // filter and still on the chart when the user asks for everything.
  //
  // Re-measure before writing. The browser knows the target was beaten, but
  // only the server should decide that a permanent marker gets written.
  if (intent === 'milestone') {
    const targetsBody = await (await admin.graphql(TARGETS_QUERY)).json();
    const target = targetsBody.data?.analyticsTargets?.nodes?.find(
      (node) => node.id === formData.get('targetId'),
    );
    if (!target?.shopifyqlQuery) {
      return {intent, userErrors: [{message: 'That target no longer exists.'}]};
    }

    const actual = progressValue(
      await runOptional(admin, `
        query MeasureTarget {
          shopifyqlQuery(query: ${JSON.stringify(target.shopifyqlQuery)}) {
            tableData { rows }
            parseErrors
          }
        }
      `),
    );
    const expected = Number(target.expectedValue);
    if (actual === null || actual < expected) {
      return {
        intent,
        userErrors: [{message: 'That target has not been beaten yet.'}],
      };
    }

    const money = new Intl.NumberFormat(
      new URL(request.url).searchParams.get('locale') ?? 'en',
      {style: 'currency', currency: target.currencyCode},
    );
    const percent = Math.round((actual / expected) * 100);

    const response = await admin.graphql(ANNOTATION_CREATE, {
      variables: {
        input: {
          type: 'revenue_milestone',
          title: clamp(`${target.name} hit ${percent}% of goal`, 75),
          description: clamp(
            `${money.format(actual)} against a ${money.format(expected)} goal, measured on ${CAMPAIGN.endDate}.`,
            150,
          ),
          startedAt: markedAt(CAMPAIGN.endDate),
        },
      },
    });

    const result = (await response.json()).data.analyticsAnnotationCreate;
    return {
      intent,
      userErrors: result.userErrors,
      created: [result.analyticsAnnotation],
    };
  }
  // [END campaign-dashboard.milestone]

  // [START campaign-dashboard.lifecycle]
  // Launching is the one action a user actually takes. Everything the campaign
  // needs on the store happens here: the funnel is reported, the schedule goes
  // on the timeline, and the goals are set. Each write is guarded, so a retry
  // after a partial failure finishes the job instead of duplicating it.
  if (intent === 'launch') {
    const userErrors = [];

    const events = await sendCampaignFunnel({
      shopId: formData.get('shopId'),
      campaignId: CAMPAIGN.id,
      startDate: CAMPAIGN.startDate,
      timeZone: formData.get('timeZone'),
    }).catch((error) => ({accepted: 0, failures: [error.message]}));
    userErrors.push(...events.failures.map((message) => ({message})));

    // Annotations have no uniqueness constraint, so a second launch would write
    // the campaign onto the timeline twice. Skip the marks if they're there.
    const existing = await (await admin.graphql(ANNOTATIONS_QUERY)).json();
    const appId = existing.data?.currentAppInstallation?.app?.id;
    const already = (existing.data?.shop?.analyticsAnnotations?.nodes ?? []).some(
      (node) => node.createdByApp?.id === appId,
    );
    if (!already) {
      userErrors.push(
        ...(await writeMarks()).flatMap((result) => result.userErrors),
      );
    }

    // Same for the goals: one store-wide target is the point, not five.
    const priorTargets = await (await admin.graphql(TARGETS_QUERY)).json();
    if ((priorTargets.data?.analyticsTargets?.nodes ?? []).length === 0) {
      const [store, scoped] = await Promise.all([
        createStoreTarget(),
        createProductTarget(),
      ]);
      userErrors.push(...store.userErrors, ...scoped.userErrors);
    }

    return {intent, userErrors, accepted: events.accepted};
  }

  // Cancelling takes the campaign back off the store. A campaign that never
  // ran shouldn't leave markers explaining a spike it didn't cause, or goals
  // nobody is working toward.
  if (intent === 'cancel') {
    const userErrors = [];

    // Delete only what this app created. Another app's markers, and Shopify's
    // own, aren't this app's to remove, and the API won't let it try.
    const body = await (await admin.graphql(ANNOTATIONS_QUERY)).json();
    const ownId = body.data?.currentAppInstallation?.app?.id;
    const mine = (body.data?.shop?.analyticsAnnotations?.nodes ?? []).filter(
      (node) => node.createdByApp?.id === ownId,
    );
    for (const node of mine) {
      const response = await admin.graphql(ANNOTATION_DELETE, {variables: {id: node.id}});
      userErrors.push(...(await response.json()).data.analyticsAnnotationDelete.userErrors);
    }

    const targetsBody = await (await admin.graphql(TARGETS_QUERY)).json();
    const ids = (targetsBody.data?.analyticsTargets?.nodes ?? []).map((node) => node.id);
    if (ids.length > 0) {
      const response = await admin.graphql(TARGETS_DELETE, {variables: {ids}});
      userErrors.push(...(await response.json()).data.analyticsTargetsDelete.userErrors);
    }

    // App Events can't be recalled. Reporting one is a statement about
    // something that happened, so the API has no delete.
    return {intent, userErrors, deleted: [...mine.map((n) => n.id), ...ids]};
  }
  // [END campaign-dashboard.lifecycle]

  return {intent, userErrors: [{message: `Unknown intent: ${intent}`}]};
}

export default function Index() {
  const {
    campaign,
    locale,
    fatal,
    sales,
    shopId,
    currencyCode,
    timeZone,
    topProducts,
    annotations = [],
    annotationsError,
    appId,
    targets = [],
    insight,
    insightWeeks,
    appEvents,
    creatives,
    sequence = [],
    bounces,
    incident,
  } = useLoaderData();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const [showWhy, setShowWhy] = useState(false);

  // [START campaign-dashboard.client-only]
  // Polaris Viz reads window when it draws, so it can't render during SSR.
  const [isClient, setIsClient] = useState(false);
  useEffect(() => setIsClient(true), []);
  // [END campaign-dashboard.client-only]

  // [START campaign-dashboard.tooltip-fix]
  // Feeds the scroll offset to chart-tooltip.css, which uses it to put the
  // ComboChart tooltip back where the chart is. Nothing to do with ShopifyQL,
  // and safe to drop once Polaris Viz portals that tooltip like its others do.
  useEffect(() => {
    const sync = () =>
      document.documentElement.style.setProperty(
        '--chart-scroll-y',
        `${window.scrollY}px`,
      );
    sync();
    window.addEventListener('scroll', sync, {passive: true});
    return () => window.removeEventListener('scroll', sync);
  }, []);
  // [END campaign-dashboard.tooltip-fix]

  // [START campaign-dashboard.metric-card-ready]
  // App Bridge resolves the ShopifyQL data plugin asynchronously. Rendering the
  // card before it lands starts the card in an error state.
  const [cardReady, setCardReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const poll = setInterval(() => {
      if (!cancelled && window.shopify?.shopifyQL) {
        setCardReady(true);
        clearInterval(poll);
      }
    }, 100);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);
  // [END campaign-dashboard.metric-card-ready]

  // Declared after the hooks so the hook order stays stable across renders.
  if (fatal) {
    return (
      <s-page heading={campaign.title}>
        <s-banner heading="The dashboard can't read analytics" tone="critical">
          <s-paragraph>{fatal}</s-paragraph>
        </s-banner>
      </s-page>
    );
  }

  // [START campaign-dashboard.parse-errors]
  // Combine the parse errors from the queries the dashboard can't render
  // without. App Events is optional, so its failure is reported separately
  // rather than replacing the whole dashboard.
  const parseErrors = [...sales.parseErrors, ...topProducts.parseErrors];
  if (parseErrors.length > 0) {
    return (
      <s-page heading={campaign.title}>
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
  // [END campaign-dashboard.parse-errors]

  // [START campaign-dashboard.read]
  const {columns, rows} = sales.tableData;

  // Read cells by column name, not by position, so reordering SHOW is safe.
  const cell = (row, name) => row[name];
  // [END campaign-dashboard.read]

  // [START campaign-dashboard.format]
  // Values arrive as strings, so format by the column's dataType. Keep MONEY
  // as a string to avoid rounding, and format it in the store's currency.
  // Pass the locale explicitly. Omitting it lets Node and the browser pick
  // different defaults, which renders USD as "US$0.00" on the server and
  // "$0.00" on the client and breaks hydration.
  const currency = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
  });
  // Axis ticks sit at the container's edges, so a full-precision amount gets
  // clipped at both ends. Ticks get the compact form and values keep the full.
  const compactCurrency = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const shortDate = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  });
  const integer = new Intl.NumberFormat(locale);

  // DAY_TIMESTAMP is a date-only string, which JavaScript parses as UTC
  // midnight. Formatting that directly shows the day before anywhere west of
  // UTC. The time suffix forces local parsing so the label matches the data.
  const asLocalDay = (value) => new Date(`${String(value).slice(0, 10)}T00:00:00`);
  // Polaris Viz runs an axis formatter over values it has already formatted on
  // some paths, so this has to survive being handed its own output.
  const asShortDay = (value) => {
    const day = asLocalDay(value);
    return Number.isNaN(day.getTime()) ? String(value) : shortDate.format(day);
  };

  // Polaris Viz runs an axis formatter over labels it has already formatted, so
  // this has to be idempotent. Anything that isn't a raw day passes through.
  const dayLabel = (value) => {
    const date = asLocalDay(value);
    return Number.isNaN(date.getTime()) ? String(value) : shortDate.format(date);
  };

  // Annotation types and event attributes are snake_case identifiers. Title
  // them rather than putting hard_bounce in front of a user.
  const humanize = (value) =>
    String(value)
      .replace(/_/g, ' ')
      .replace(/^./, (character) => character.toUpperCase());

  const formatValue = (value, dataType) => {
    if (value === null) return '—';

    switch (dataType) {
      case 'MONEY':
        return currency.format(value);
      case 'DAY_TIMESTAMP':
        return shortDate.format(asLocalDay(value));
      case 'INTEGER':
        return integer.format(Number(value));
      default:
        return String(value);
    }
  };
  // [END campaign-dashboard.format]

  // [START campaign-dashboard.totals]
  // WITH TOTALS repeats the period total on every row and, with COMPARE TO, the
  // compared period's total too. Read both from the first row, then compute the
  // change yourself, guarding divide-by-zero so a new store isn't misleading.
  const totalSales = rows[0]?.['total_sales__totals'] ?? '0';
  const previousTotal = Number(
    rows[0]?.['comparison_total_sales__previous_period__totals'] ?? 0,
  );
  const percentChange =
    previousTotal === 0
      ? null
      : ((Number(totalSales) - previousTotal) / Math.abs(previousTotal)) * 100;
  // [END campaign-dashboard.totals]

  // [START campaign-dashboard.states]
  if (navigation.state === 'loading') {
    return (
      <s-page heading={campaign.title}>
        <s-section>
          <s-spinner accessibilityLabel="Loading campaign results" />
        </s-section>
      </s-page>
    );
  }

  // TIMESERIES fills every day in the range, so an empty period returns rows
  // of zeros, not zero rows. Treat a zero period total as empty.
  const isEmpty = rows.length === 0 || Number(totalSales) === 0;
  // [END campaign-dashboard.states]

  // [START campaign-dashboard.metric-card]
  // WITH TOTALS gives the card its headline number, PERCENT_CHANGE and COMPARE
  // TO give it the change indicator, and ORDER BY gives it a dated x-axis.
  //
  // Neither COMPARE TO TARGETS nor ANNOTATE belongs here. Both parse, and each
  // makes the card fetch against a field the public GraphQL Admin API doesn't
  // have, so the card renders the line and silently drops the overlay.
  const cardQuery = [
    'FROM sales',
    'SHOW total_sales',
    'TIMESERIES day',
    'WITH TOTALS, PERCENT_CHANGE',
    WINDOW,
    'COMPARE TO previous_period',
    'ORDER BY day ASC',
    'LIMIT 100',
    'VISUALIZE total_sales TYPE line',
  ].join(' ');

  // ANNOTATE still earns its place. This is the query a user pastes into the
  // ShopifyQL editor to see this app's markers on their own reports, and it's
  // why writing each mark under the right `type` matters.
  const editorQuery = [
    'FROM sales',
    'SHOW total_sales',
    'TIMESERIES day',
    WINDOW,
    'VISUALIZE total_sales TYPE line',
    `ANNOTATE ${ANNOTATE_CLAUSE}`,
  ].join('\n');
  // [END campaign-dashboard.metric-card]

  // [START campaign-dashboard.annotations-overlay]
  // The query returns everything in the window. Split it: the app can edit and
  // delete its own markers, and can only read everyone else's. Both belong on
  // the chart, because both explain the shape of the line.
  const ours = annotations.filter(
    (annotation) => annotation.createdByApp?.id === appId,
  );
  const others = annotations.filter(
    (annotation) => annotation.createdByApp?.id !== appId,
  );

  // startKey is matched against the chart's formatted x-axis labels, not the
  // raw data keys. An annotation whose formatted key isn't on the axis is
  // dropped without an error, so both sides run through the same formatter.
  const chartAnnotations = annotations.map((annotation) => ({
    axis: 'x',
    startKey: annotation.startedAt.slice(0, 10),
    label: annotation.title,
    content: {
      title: annotation.title,
      content: annotation.description,
    },
  }));

  const openCampaign = ours.find((annotation) => !annotation.endedAt);
  const incidentFlagged = ours.some(
    (annotation) => annotation.type === 'other',
  );
  // [END campaign-dashboard.annotations-overlay]

  // [START campaign-dashboard.timeline]
  // The Shopify admin draws annotations as a strip under the chart, one dot for
  // each day, sized by how much happened. Group by day and count to get the
  // same read: where the busy days were, and what was on them.
  const timeline = [...
    annotations
      .reduce((days, annotation) => {
        const day = annotation.startedAt.slice(0, 10);
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(annotation);
        return days;
      }, new Map())
  ]
    .map(([day, events]) => ({day, events}))
    .sort((a, b) => a.day.localeCompare(b.day));

  const busiestDay = Math.max(1, ...timeline.map((entry) => entry.events.length));

  // Place each dot by its date across the campaign window, so one marker on one
  // day reads as a point in time rather than a stray circle at the left edge.
  const windowStart = asLocalDay(campaign.startDate).getTime();
  const windowSpan = asLocalDay(campaign.endDate).getTime() - windowStart;
  const dayOffset = (day) =>
    windowSpan <= 0
      ? 0
      : Math.min(
          1,
          Math.max(0, (asLocalDay(day).getTime() - windowStart) / windowSpan),
        );
  // [END campaign-dashboard.timeline]

  // [START campaign-dashboard.insight-chart]
  // The insight is weekly, and annotations land on days. Bucket each one into
  // the week that contains it so the markers sit on the point they explain.
  const insightWeekly = insight
    ? insight.weeks.map((week, index) => ({
        key: week,
        value: insight.series[index],
      }))
    : [];

  // Polaris Viz keys annotations by startKey, so two on the same week would
  // overwrite each other. Merge them into one marker instead.
  const insightAnnotations = insight
    ? [
        ...annotations.reduce((weeks, annotation) => {
          const day = annotation.startedAt.slice(0, 10);
          const week = insight.weeks.filter((start) => start <= day).at(-1);
          if (!week) return weeks;
          if (!weeks.has(week)) weeks.set(week, []);
          weeks.get(week).push(annotation.title);
          return weeks;
        }, new Map()),
      ].map(([week, titles]) => ({
        axis: 'x',
        startKey: week,
        label: titles.length === 1 ? titles[0] : `${titles.length} markers`,
        content: {
          title: `Week of ${asShortDay(week)}`,
          content: titles.join(', '),
        },
      }))
    : [];
  // [END campaign-dashboard.insight-chart]

  // [START campaign-dashboard.detail-columns]
  // WITH TOTALS and COMPARE TO added __totals and comparison_ columns the
  // metric already uses. Show only the base daily columns in the table.
  const detailColumns = columns.filter(
    (column) =>
      !column.name.endsWith('__totals') &&
      !column.name.startsWith('comparison_'),
  );
  // [END campaign-dashboard.detail-columns]

  // [START campaign-dashboard.target-split]
  // A target with no `filters` measures the whole store. One with `filters`
  // measures a slice of it, so the two answer different questions and both
  // belong on the page.
  const storeTarget = targets.find((entry) => !entry.filters);
  const scopedTargets = targets.filter((entry) => entry.filters);
  // [END campaign-dashboard.target-split]

  const changeTone =
    percentChange !== null && percentChange >= 0 ? 'success' : 'critical';
  const changeLabel =
    percentChange === null
      ? null
      : `${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(1)}% vs prior period`;
  const busy = fetcher.state !== 'idle';
  const userErrors = fetcher.data?.userErrors ?? [];
  const accepted = fetcher.data?.accepted;
  const acceptedTotal = Object.values(accepted ?? {}).reduce(
    (sum, count) => sum + count,
    0,
  );

  // [START campaign-dashboard.funnel-totals]
  // TIMESERIES gives one row per day. The funnel is the campaign-wide shape, so
  // sum each metric down its column and derive the rates from those totals.
  const total = (metric) =>
    appEvents.tableData.rows.reduce(
      (sum, row) => sum + Number(row[metric] ?? 0),
      0,
    );

  // A funnel scores every stage against its own first stage, so splitting the
  // channels apart is what keeps a 20-person SMS from being measured against
  // the size of the email list.
  const formsSubmitted = total('forms_submitted');
  const emailSent = total('emails_sent');
  const smsSent = total('sms_messages_sent');
  const pushSent = total('push_notifications_sent');

  const rate = (value, base) =>
    base > 0 ? `${((value / base) * 100).toFixed(1)}%` : '—';

  // Bounces and unsubscribes are the numbers that decide whether the send was
  // worth making. Reach is the campaign's total across all three channels, and
  // the list either grew by more than it lost or it didn't.
  const health = {
    channels: [emailSent, smsSent, pushSent].filter((sent) => sent > 0).length,
    bounceRate: rate(total('emails_bounced'), emailSent),
    unsubRate: rate(
      total('email_unsubscribes') + total('sms_unsubscribes'),
      total('emails_delivered') + total('sms_messages_delivered'),
    ),
    reach:
      total('emails_delivered') +
      total('sms_messages_delivered') +
      total('push_notifications_sent'),
    netList:
      total('leads_captured') -
      total('email_unsubscribes') -
      total('sms_unsubscribes'),
  };
  // [END campaign-dashboard.funnel-totals]

  // [START campaign-dashboard.channel-funnels]
  // One funnel for each channel, and they're deliberately different lengths.
  // The registry defines the stages a channel can report, so email carries four
  // and push carries two. Reporting a stage a channel doesn't have would mean
  // inventing the number.
  const channelFunnels = [
    {
      name: 'Email',
      stages: [
        ['Sent', emailSent],
        ['Delivered', total('emails_delivered')],
        ['Opened', total('emails_opened')],
        ['Clicked', total('email_clicks')],
      ],
    },
    {
      name: 'SMS',
      stages: [
        ['Sent', smsSent],
        ['Delivered', total('sms_messages_delivered')],
        ['Clicked', total('sms_clicks')],
      ],
    },
    {
      name: 'Push',
      stages: [
        ['Sent', pushSent],
        ['Opened', total('push_notifications_opened')],
      ],
    },
  ]
    .filter((channel) => channel.stages[0][1] > 0)
    .map((channel) => ({
      name: channel.name,
      data: [
        {
          name: channel.name,
          data: channel.stages.map(([key, value]) => ({key, value})),
        },
      ],
    }));

  // The signup form is its own funnel. It runs before any of the sends and
  // measures whether the list grew, not whether a send landed.
  const listFunnel =
    formsSubmitted > 0
      ? [
          {
            name: 'List growth',
            data: [
              {key: 'Submitted', value: formsSubmitted},
              {key: 'Captured', value: total('leads_captured')},
              {key: 'Incentivized', value: total('incentives_issued')},
            ],
          },
        ]
      : null;
  // [END campaign-dashboard.channel-funnels]


  // [START campaign-dashboard.sends-by-day]
  // Both queries run TIMESERIES day over the same window, so their rows line up
  // by date and the app's own sends can be drawn against the store's sales.
  // This is the whole point of the dashboard on one axis: what the app did on
  // the left, what the store earned on the right.
  const byDay = new Map(
    appEvents.tableData.rows.map((row) => [row['day'], row]),
  );
  const daily = (metric) =>
    rows.map((row) => ({
      key: row['day'],
      value: Number(byDay.get(row['day'])?.[metric] ?? 0),
    }));

  const sends = [
    {name: 'Email', data: daily('emails_sent')},
    {name: 'SMS', data: daily('sms_messages_sent')},
    {name: 'Push', data: daily('push_notifications_sent')},
  ];
  // [END campaign-dashboard.sends-by-day]

  // [START campaign-dashboard.sequence-charts]
  // The sequence, in the order it went out. Reach is the only count worth a
  // bar. An engaged bar beside it would plot the numerator of the rate line
  // next to its denominator, which is the same fact drawn twice.
  const sequenceBars = [
    {name: 'Reached', data: sequence.map((t) => ({key: t.name, value: t.reached}))},
  ];

  const sequenceRate = [
    {name: 'Engagement rate', data: sequence.map((t) => ({key: t.name, value: t.rate}))},
  ];

  // What the sequence cost. Unsubscribes are small enough next to the sends
  // that a bar for them would be a flat line, so they get read out instead.
  const first = sequence.at(0);
  const last = sequence.at(-1);
  const fatigue =
    first && last !== first
      ? {
          from: Math.round(first.rate),
          to: Math.round(last.rate),
          falling: last.rate < first.rate,
          lost: sequence.reduce((sum, touch) => sum + touch.lost, 0),
          touches: sequence.length,
          worst: sequence.reduce((a, b) => (b.lost > a.lost ? b : a)),
        }
      : null;

  // Why a bounce happened decides what a user does about it. A hard bounce is a
  // dead address to drop, and a soft one is worth retrying.
  const bounceReasons = (bounces?.tableData?.rows ?? [])
    .filter((row) => Number(row['emails_bounced']) > 0)
    .map((row) => ({
      reason: row['recipient_status'] ? humanize(row['recipient_status']) : 'Not recorded',
      count: Number(row['emails_bounced']),
    }));
  // [END campaign-dashboard.sequence-charts]

  // Submit through the fetcher rather than a native form, so the buttons don't
  // depend on s-button forwarding submit events out of its shadow root.
  const submit = (intent, fields = {}) =>
    fetcher.submit({intent, shopId, timeZone, ...fields}, {method: 'post'});

  return (
    <s-page heading={campaign.title}>
      {annotationsError ? (
        <s-banner heading="Annotations aren't readable yet" tone="warning">
          <s-paragraph>
            {annotationsError} Reinstall the app so the new annotation scopes
            are granted.
          </s-paragraph>
        </s-banner>
      ) : null}

      {userErrors.length > 0 ? (
        <s-banner heading="That write didn't go through" tone="warning">
          <s-unordered-list>
            {userErrors.map((error) => (
              <s-list-item key={error.message}>{error.message}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      ) : null}

      {/* [START campaign-dashboard.incident-banner] */}
      {incident && !incidentFlagged ? (
        <s-banner heading="This send had a deliverability problem" tone="warning">
          <s-paragraph>{incident.description}</s-paragraph>
          <s-button
            disabled={busy}
            onClick={() => submit('flag-incident')}
            slot="primary-action"
          >
            Put this on the store's charts
          </s-button>
        </s-banner>
      ) : null}
      {/* [END campaign-dashboard.incident-banner] */}

      {accepted ? (
        <s-banner
          heading="Campaign funnel reported"
          tone={acceptedTotal > 0 ? 'success' : 'warning'}
        >
          <s-paragraph>
            Shopify accepted {integer.format(acceptedTotal)} events across{' '}
            {Object.keys(accepted).length} stages. Processing is asynchronous,
            so they won't appear below right away.
          </s-paragraph>
        </s-banner>
      ) : null}

      {/* [START campaign-dashboard.insight-render] */}
      {/* The lead. One product, one streak, one number, and a control that
          answers "why" from the annotations already on the page. */}
      {insight ? (
        <s-section>
          <s-stack direction="block" gap="small-300">
            <s-text color="subdued">
              Insight, {shortDate.format(asLocalDay(insight.weeks.at(-1)))}
            </s-text>

            <s-heading>
              {insight.title} {insight.rising ? 'is up' : 'is down'} for the{' '}
              {ordinal(insight.streak)} week running
            </s-heading>

            <s-paragraph>
              Gross sales{' '}
              {insight.rising ? 'reached' : 'fell to'}{' '}
              {currency.format(insight.latest)} last week,{' '}
              {insight.growth === null
                ? `${currency.format(insight.swing)} ${
                    insight.rising ? 'above' : 'below'
                  }`
                : `${insight.rising ? 'up' : 'down'} ${integer.format(
                    Math.abs(insight.growth),
                  )}% from`}{' '}
              where the run started.
            </s-paragraph>

            {/* The whole five-week window, not just the run, with everything
                anyone recorded against those weeks pinned to the point it
                explains. The weeks before the run are what make the run mean
                something, and the markers are the why. */}
            {isClient ? (
              <PolarisVizProvider>
                <div style={{height: 240, padding: '0 12px'}}>
                  <LineChart
                    annotations={insightAnnotations}
                    data={[
                      {
                        name: `${insight.title} gross sales`,
                        data: insightWeekly,
                      },
                    ]}
                    xAxisOptions={{labelFormatter: asShortDay}}
                    yAxisOptions={{
                      labelFormatter: (value) => currency.format(value),
                    }}
                    showLegend={false}
                  />
                </div>
              </PolarisVizProvider>
            ) : null}

            <s-button
              variant="secondary"
              onClick={() => setShowWhy((shown) => !shown)}
            >
              {showWhy ? 'Hide the markers' : 'List the markers'}
            </s-button>

            {/* The markers again as text. A pin needs a pointer to read, and
                the titles are the part a user acts on. */}
            {showWhy ? (
              annotations.length === 0 ? (
                <s-paragraph>
                  Nothing is marked on the store's timeline for this window yet.
                </s-paragraph>
              ) : (
                <s-unordered-list>
                  {annotations.map((annotation) => (
                    <s-list-item key={annotation.id}>
                      {shortDate.format(asLocalDay(annotation.startedAt))}:{' '}
                      {annotation.title}
                    </s-list-item>
                  ))}
                </s-unordered-list>
              )
            ) : null}
          </s-stack>
        </s-section>
      ) : (
        // An insight needs two consecutive weeks moving the same direction for
        // one product. Say which of the two is missing rather than hiding.
        <s-section>
          <s-stack direction="block" gap="small-300">
            <s-text color="subdued">Insight</s-text>
            <s-paragraph>
              No product is on a multi-week run yet.{' '}
              {insightWeeks < 2
                ? `The last five weeks hold ${integer.format(insightWeeks)} week${
                    insightWeeks === 1 ? '' : 's'
                  } with sales, and a run needs at least two.`
                : 'Every product changed direction week to week over the last five weeks.'}
            </s-paragraph>
          </s-stack>
        </s-section>
      )}
      {/* [END campaign-dashboard.insight-render] */}

      {/* [START campaign-dashboard.card-render] */}
      <s-section heading="Campaign performance">
        {cardReady ? (
          <s-shopifyql-metric-card
            heading="Total sales"
            description={`${campaign.startDate} to ${campaign.endDate}`}
            query={cardQuery}
          ></s-shopifyql-metric-card>
        ) : (
          <s-spinner accessibilityLabel="Loading metric card" />
        )}
      </s-section>
      {/* [END campaign-dashboard.card-render] */}

      <s-section heading="Campaign setup">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Campaign total {currency.format(totalSales)}
            {changeLabel ? `, ${changeLabel}` : ''}
          </s-paragraph>

          {/* [START campaign-dashboard.lifecycle-render] */}
          {/* Launching is one action for the user and several writes for the
              app. Splitting it into a button for each write would make the
              user do the app's job. */}
          {ours.length === 0 && targets.length === 0 ? (
            <s-stack direction="block" gap="small-300">
              <s-paragraph>
                Launching reports the funnel, writes all{' '}
                {integer.format(campaign.marks.length)} markers onto the store's
                analytics timeline, and sets the two goals this campaign is
                measured against.
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  disabled={busy}
                  onClick={() => submit('launch')}
                >
                  Launch the campaign
                </s-button>
              </s-stack>
            </s-stack>
          ) : (
            <s-stack direction="inline" gap="base">
              <s-button disabled={busy} onClick={() => submit('cancel')}>
                Cancel the campaign
              </s-button>
              <s-text color="subdued">
                Cancelling removes the markers and goals. The funnel stays,
                because a reported event is a record of something that happened
                and App Events has no delete.
              </s-text>
            </s-stack>
          )}
          {/* [END campaign-dashboard.lifecycle-render] */}

          {/* [START campaign-dashboard.target-render] */}
          {targets.length === 0 ? (
            <s-paragraph>No revenue target set for this window yet.</s-paragraph>
          ) : (
            <s-stack direction="block" gap="small-300">
              {/* Store-wide first. It's the number the campaign is judged on,
                  and the scoped goals read as a breakdown underneath it. */}
              {[storeTarget, ...scopedTargets].filter(Boolean).map((entry) => (
                <s-stack key={entry.id} direction="block" gap="small-500">
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    alignItems="center"
                  >
                    <s-text type="strong">{entry.name}</s-text>
                    <s-badge
                      tone={entry.percent >= 100 ? 'success' : 'info'}
                      icon={
                        entry.percent >= 100 ? 'check-circle' : 'clock'
                      }
                    >
                      {entry.queryError
                        ? "Can't be measured"
                        : entry.percent === null
                          ? 'Measuring'
                          : `${integer.format(entry.percent)}% of goal`}
                    </s-badge>
                  </s-stack>

                  {/* App Home has no progress bar component. A grey fill on a
                      grey track is unreadable at this height, so the fill
                      carries the same colour as the badge above it. The
                      percentage is Shopify's own measurement, taken from the
                      target's generated `shopifyqlQuery`. */}
                  <div
                    role="progressbar"
                    aria-valuenow={entry.percent ?? 0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${entry.name}, ${entry.percent ?? 0}% of goal`}
                    style={{
                      height: 8,
                      borderRadius: 4,
                      overflow: 'hidden',
                      background: 'var(--s-color-bg-fill-tertiary, #e3e3e3)',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        borderRadius: 4,
                        width: `${Math.min(Math.max(entry.percent ?? 0, 0), 100)}%`,
                        background:
                          entry.percent >= 100
                            ? 'var(--s-color-bg-fill-success, #29845a)'
                            : 'var(--s-color-bg-fill-brand, #005bd3)',
                      }}
                    />
                  </div>

                  <s-text color="subdued">
                    {entry.actual === null
                      ? currency.format(entry.expectedValue)
                      : `${currency.format(entry.actual)} of ${currency.format(entry.expectedValue)}`}
                    {entry.filters ? `, scoped to ${entry.filters}` : ', store-wide'}
                  </s-text>

                  {entry.queryError ? (
                    <s-text tone="critical">{entry.queryError}</s-text>
                  ) : null}

                  <s-stack direction="inline" gap="small-300">
                    {entry.percent !== null && entry.percent >= 100 ? (
                      <s-button
                        disabled={busy}
                        onClick={() =>
                          submit('milestone', {targetId: entry.id})
                        }
                      >
                        Mark this win on analytics
                      </s-button>
                    ) : null}

                    {entry.percent !== null && entry.percent >= 100 ? (
                      <s-button
                        disabled={busy}
                        onClick={() =>
                          submit('raise-target', {
                            targetId: entry.id,
                            actual: entry.actual,
                          })
                        }
                      >
                        Raise the goal
                      </s-button>
                    ) : null}
                  </s-stack>
                </s-stack>
              ))}
            </s-stack>
          )}
          {/* [END campaign-dashboard.target-render] */}

          {/* [START campaign-dashboard.close-render] */}
          {/* Closing is the write that makes an annotation worth reading. The
              marker goes up saying what the campaign is, and comes back down
              saying what it earned. */}
          {openCampaign ? (
            <s-stack direction="block" gap="small-300">
              <s-paragraph>
                {integer.format(ours.length)}{' '}
                {ours.length === 1 ? 'marker is' : 'markers are'} on the store's
                timeline, and the campaign has run since{' '}
                {shortDate.format(asLocalDay(openCampaign.startedAt))}. Closing
                it rewrites the campaign marker with what it earned and sets its
                end date.
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    submit('close-annotation', {annotationId: openCampaign.id})
                  }
                >
                  Close the campaign with its result
                </s-button>
              </s-stack>
            </s-stack>
          ) : ours.length > 0 ? (
            <s-paragraph>
              The campaign is closed, and its marker now reports the result.
            </s-paragraph>
          ) : null}
          {/* [END campaign-dashboard.close-render] */}
        </s-stack>
      </s-section>

      {isEmpty ? (
        <s-section heading="No sales in the campaign window">
          <s-paragraph>
            When this store makes a sale between {campaign.startDate} and{' '}
            {campaign.endDate}, the dashboard shows the campaign total, its
            daily trend, and the products it moved.
          </s-paragraph>
        </s-section>
      ) : (
        <>
          {/* [START campaign-dashboard.chart] */}
          <s-section heading="What the app did, against what the store sold">
            {/* Two datasets that can't share a FROM clause, drawn on one pair
                of axes because they share a day. Say what to look for, or the
                reader is left to guess which series is the claim. */}
            <s-paragraph>
              Bars are the messages this app sent each day. The line is what the
              store sold. The markers underneath are everything recorded against
              those days, including the ones this app had nothing to do with.
            </s-paragraph>

            {isClient ? (
              <PolarisVizProvider>
                <div className="chart-tooltip-fix" style={{height: 380}}>
                  <ComboChart
                    annotations={chartAnnotations}
                    xAxisOptions={{labelFormatter: dayLabel}}
                    data={[
                      {
                        shape: 'Bar',
                        name: 'Messages sent',
                        yAxisOptions: {integersOnly: true},
                        series: sends,
                      },
                      {
                        shape: 'Line',
                        name: 'Sales',
                        yAxisOptions: {
                          labelFormatter: (value) => currency.format(value),
                        },
                        series: [
                          {
                            name: 'Total sales',
                            data: rows.map((row) => ({
                              key: row['day'],
                              value: Number(row['total_sales']),
                            })),
                          },
                        ],
                      },
                    ]}
                  />
                </div>
              </PolarisVizProvider>
            ) : null}

            {/* [START campaign-dashboard.timeline-render] */}
            {/* The strip the Shopify admin draws under its charts. One dot for
                each day that has annotations, sized by how many, and a tooltip
                that lists the day rather than making the user hover each one. */}
            {timeline.length > 0 ? (
              <s-stack direction="block" gap="small-400">
                {/* The inline padding is half the widest dot, so a marker on
                    the first or last day sits fully inside the card. */}
                <div style={{position: 'relative', height: 24, margin: '0 8px'}}>
                  <div
                    style={{
                      position: 'absolute',
                      insetInline: 0,
                      top: 11,
                      height: 2,
                      background: 'var(--s-color-border, #e3e3e3)',
                    }}
                  />
                  {timeline.map((entry) => {
                    // A tooltip is a sibling of its trigger, not a wrapper. The
                    // trigger points at it by id through `interestFor`.
                    const tooltipId = `timeline-${entry.day}`;
                    const size =
                      8 + Math.round((entry.events.length / busiestDay) * 8);
                    return (
                      <Fragment key={entry.day}>
                        <s-tooltip id={tooltipId}>
                          <s-paragraph>
                            {shortDate.format(asLocalDay(entry.day))}
                          </s-paragraph>
                          {entry.events.slice(0, 5).map((annotation) => (
                            <s-paragraph key={annotation.id}>
                              {annotation.title}
                            </s-paragraph>
                          ))}
                          {entry.events.length > 5 ? (
                            <s-paragraph>
                              +{entry.events.length - 5} more events
                            </s-paragraph>
                          ) : null}
                        </s-tooltip>
                        <span
                          style={{
                            position: 'absolute',
                            top: 12 - size / 2,
                            left: `calc(${dayOffset(entry.day) * 100}% - ${size / 2}px)`,
                          }}
                        >
                          <s-clickable
                            interestFor={tooltipId}
                            background="strong"
                            borderRadius="large"
                            inlineSize={`${size}px`}
                            blockSize={`${size}px`}
                            onClick={() => setShowWhy(true)}
                            accessibilityLabel={`${entry.events.length} ${
                              entry.events.length === 1 ? 'event' : 'events'
                            } on ${entry.day}`}
                          />
                        </span>
                      </Fragment>
                    );
                  })}
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    margin: '0 8px',
                  }}
                >
                  <s-text color="subdued">
                    {shortDate.format(asLocalDay(campaign.startDate))}
                  </s-text>
                  <s-text color="subdued">
                    {shortDate.format(asLocalDay(campaign.endDate))}
                  </s-text>
                </div>

                <s-text color="subdued">
                  {integer.format(annotations.length)}{' '}
                  {annotations.length === 1 ? 'marker' : 'markers'} on{' '}
                  {integer.format(timeline.length)}{' '}
                  {timeline.length === 1 ? 'day' : 'days'}.{' '}
                  {integer.format(ours.length)} written by this app,{' '}
                  {integer.format(others.length)} by other apps.
                </s-text>

                {/* The markers this app wrote belong to the store, so they show
                    up in the store's own reports too. Hand over the query. */}
                <s-stack direction="block" gap="small-500">
                  <s-text color="subdued">
                    Run this in the ShopifyQL editor to see these markers on
                    your own chart:
                  </s-text>
                  <s-box background="subdued" borderRadius="base" padding="small-200">
                    {/* App Home has no code primitive, so the newlines in the
                        query need pre-wrap to survive. */}
                    <pre
                      style={{
                        margin: 0,
                        fontSize: '0.75rem',
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {editorQuery}
                    </pre>
                  </s-box>
                </s-stack>
              </s-stack>
            ) : (
              <s-text color="subdued">
                Nothing is marked on the store's timeline between{' '}
                {campaign.startDate} and {campaign.endDate}. Mark the campaign
                to put this app's events under the chart.
              </s-text>
            )}
            {/* [END campaign-dashboard.timeline-render] */}
          </s-section>
          {/* [END campaign-dashboard.chart] */}

          {/* [START campaign-dashboard.detail-table] */}
          <s-section heading="Daily breakdown">
            <s-table variant="auto">
              <s-table-header-row>
                {detailColumns.map((column, index) => (
                  <s-table-header
                    key={column.name}
                    listSlot={index === 0 ? 'primary' : 'labeled'}
                  >
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
          {/* [END campaign-dashboard.detail-table] */}

          {/* [START campaign-dashboard.top-products-render] */}
          <s-section heading="Products the campaign moved">
            {isClient ? (
              <PolarisVizProvider>
                {/* Height comes from the row count, not a constant. A
                    horizontal bar chart divides whatever height it's given
                    across its bars, so a fixed box turns TOP 10 into a stack of
                    slivers. The inline padding keeps the end ticks from being
                    clipped. */}
                <div
                  style={{
                    height: Math.max(
                      220,
                      topProducts.tableData.rows.length * 56,
                    ),
                    padding: '0 24px',
                  }}
                >
                  {/* Horizontal, because product titles are long and a rotated
                      label is unreadable. It also swaps which axis carries the
                      values: x holds the amounts, y holds the titles. GROUP BY
                      TOP folds everything outside the top N into one row whose
                      dimension is null, not a labelled "Other". */}
                  <BarChart
                    direction="horizontal"
                    showLegend={false}
                    xAxisOptions={{
                      labelFormatter: (value) => compactCurrency.format(value),
                    }}
                    data={[
                      {
                        name: 'Net sales',
                        data: topProducts.tableData.rows.map((row) => ({
                          key: row['product_title'] ?? 'All other products',
                          value: Number(row['net_sales']),
                        })),
                      },
                    ]}
                  />
                </div>
              </PolarisVizProvider>
            ) : null}
          </s-section>
          {/* [END campaign-dashboard.top-products-render] */}
        </>
      )}

      {/* [START campaign-dashboard.funnel-render] */}
      {channelFunnels.length > 0 || listFunnel ? (
        <s-section heading="Where the campaign lost people">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Every stage below is a metric this app reported. The channels stop
              at different points because the event registry gives each one its
              own stages, so email can report a click and push can't.
            </s-paragraph>

            {isClient ? (
              <PolarisVizProvider>
                <s-query-container>
                  <s-grid
                    gridTemplateColumns={`@container (inline-size > 700px) ${channelFunnels
                      .map(() => '1fr')
                      .join(' ')}, 1fr`}
                    gap="base"
                  >
                    {channelFunnels.map((channel) => (
                      <s-grid-item key={channel.name}>
                        <s-stack direction="block" gap="small-300">
                          <s-heading>{channel.name}</s-heading>
                          <div style={{height: 260}}>
                            <FunnelChartNext
                              data={channel.data}
                              labelFormatter={(value) => integer.format(value)}
                              percentageFormatter={(value) =>
                                `${Math.round(value)}%`
                              }
                            />
                          </div>
                        </s-stack>
                      </s-grid-item>
                    ))}
                  </s-grid>
                </s-query-container>
              </PolarisVizProvider>
            ) : null}

            {listFunnel && isClient ? (
              <>
                <s-paragraph>
                  The signup form runs ahead of every send. It's the only funnel
                  here that measures the list growing rather than a message
                  landing.
                </s-paragraph>
                <PolarisVizProvider>
                  <div style={{height: 260}}>
                    <FunnelChartNext
                      data={listFunnel}
                      labelFormatter={(value) => integer.format(value)}
                      percentageFormatter={(value) => `${Math.round(value)}%`}
                    />
                  </div>
                </PolarisVizProvider>
              </>
            ) : null}
          </s-stack>
        </s-section>
      ) : null}
      {/* [END campaign-dashboard.funnel-render] */}

      {/* [START campaign-dashboard.app-events-render] */}
      <s-section heading="How the sequence performed, touch by touch">
        {appEvents.unavailable || appEvents.parseErrors.length > 0 ? (
          <s-paragraph>
            App Events isn't available on this store, so the sequence isn't
            reported here. Every other panel on this page works without it.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {sequence.length === 0 ? (
              <s-paragraph>
                Nothing has been reported for this campaign yet. Processing is
                asynchronous, so a send made in the last few minutes reads as
                zero.
              </s-paragraph>
            ) : (
              <>
                <s-paragraph>
                  Nine touches over two weeks, in the order they went out. The
                  bars are how many people each one reached. The line is the
                  share of them who acted, which is the number that says whether
                  the list is still listening.
                </s-paragraph>

                {isClient ? (
                  <PolarisVizProvider>
                    <div
                      className="chart-tooltip-fix"
                      style={{height: 320, padding: '0 12px'}}
                    >
                      <ComboChart
                        data={[
                          {
                            shape: 'Bar',
                            name: 'People',
                            yAxisOptions: {integersOnly: true},
                            series: sequenceBars,
                          },
                          {
                            shape: 'Line',
                            name: 'Rate',
                            yAxisOptions: {
                              labelFormatter: (value) =>
                                `${Math.round(value)}%`,
                            },
                            series: sequenceRate,
                          },
                        ]}
                      />
                    </div>
                  </PolarisVizProvider>
                ) : null}

                {/* Email counts an open, SMS counts a click, and push counts an
                    open, because that's what each channel can report. Say so
                    rather than letting one axis imply they're the same act. */}
                <s-text color="subdued">
                  Engagement is an open for email and push, and a click for SMS.
                  Each touch is measured against its own reach.
                </s-text>

                {fatigue ? (
                  <s-paragraph>
                    Engagement {fatigue.falling ? 'fell' : 'rose'} from{' '}
                    {fatigue.from}% on the first touch to {fatigue.to}% on the
                    last, across {integer.format(fatigue.touches)} sends.{' '}
                    {integer.format(fatigue.lost)}{' '}
                    {fatigue.lost === 1 ? 'person' : 'people'} unsubscribed
                    {fatigue.worst.lost > 0
                      ? `, most of them after ${fatigue.worst.name}`
                      : ''}
                    .
                  </s-paragraph>
                ) : null}

                <s-paragraph>
                  Reached {integer.format(health.reach)} people across{' '}
                  {integer.format(health.channels)}{' '}
                  {health.channels === 1 ? 'channel' : 'channels'}.{' '}
                  {health.bounceRate} of the email bounced
                  {bounceReasons.length > 0
                    ? `, ${bounceReasons.map((b) => `${integer.format(b.count)} ${b.reason.toLowerCase()}`).join(' and ')}`
                    : ''}
                  . The signup form {health.netList >= 0 ? 'added' : 'lost'}{' '}
                  {integer.format(Math.abs(health.netList))} net.
                </s-paragraph>
              </>
            )}
          </s-stack>
        )}
      </s-section>
      {/* [END campaign-dashboard.app-events-render] */}

      {/* [START campaign-dashboard.confounders] */}
      {/* Only worth a section when there's something in it. An empty state here
          would be a paragraph about a hypothetical busy store. */}
      {others.length > 0 ? (
        <s-section heading="Other explanations for the same revenue">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {integer.format(others.length)}{' '}
              {others.length === 1 ? 'marker' : 'markers'} in this window came
              from somewhere else. Each one is a competing reason the line
              moved. Your app can read them and can't change them.
            </s-paragraph>
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Marker</s-table-header>
                <s-table-header listSlot="labeled">Date</s-table-header>
                <s-table-header listSlot="labeled">Type</s-table-header>
                <s-table-header listSlot="labeled">Written by</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {others.map((annotation) => (
                  <s-table-row key={annotation.id}>
                    <s-table-cell>{annotation.title}</s-table-cell>
                    <s-table-cell>
                      {shortDate.format(asLocalDay(annotation.startedAt))}
                    </s-table-cell>
                    <s-table-cell>{humanize(annotation.type)}</s-table-cell>
                    {/* createdByApp is null when Shopify generated it. */}
                    <s-table-cell>
                      {annotation.createdByApp?.title ?? 'Shopify'}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        </s-section>
      ) : null}
      {/* [END campaign-dashboard.confounders] */}

    </s-page>
  );
}
