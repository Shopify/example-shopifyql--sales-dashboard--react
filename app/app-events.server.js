// [START campaign-dashboard.app-events-token]
// App Events doesn't use the shop's Admin API session. It needs a
// client-credentials token minted from the app's own client ID and secret,
// which is a different auth flow from every other call in this app.
let cached = {token: null, expiresAt: 0};

async function getAppEventsToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;

  const response = await fetch('https://api.shopify.com/auth/access_token', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  const {access_token: token, expires_in: expiresIn} = await response.json();
  // Tokens last 60 minutes. Refresh a minute early rather than on expiry.
  cached = {token, expiresAt: Date.now() + (expiresIn - 60) * 1000};
  return token;
}
// [END campaign-dashboard.app-events-token]

// [START campaign-dashboard.app-events-shared]
// The whole sequence is one flow, and each touch in it is one template. Both
// are dimensions, so `flow_id` gathers the sends back together and
// `template_id` separates them.
const FLOW_ID = 5501;

const FORM_ID = 8801;
const INCENTIVE_ID = 9401;

// Attributes every marketing touch carries, whatever the channel. Each one is a
// dimension the user can group by, so send the ones that answer a question. No
// personal data: the registry types these as identifiers and labels, never
// names or addresses.
function marketing(channel, template, extra = {}) {
  return {
    channel,
    message_type: 'campaign',
    flow_id: FLOW_ID,
    template_id: template,
    consent_state: 'opted_in',
    ...extra,
  };
}
// [END campaign-dashboard.app-events-shared]

// [START campaign-dashboard.app-events-funnel]
// A campaign is a sequence, not a blast. Nine touches over two weeks, each with
// its own creative, so `template_id` carries the position in the sequence.
// Grouping by it answers the question a single send can't: is the list still
// listening on the fourth email, or are you burning it down.
//
// `audience` is who the touch went to, and the rates are what that audience
// did. They fall as the sequence runs while the unsubscribes climb, which is
// the shape a real campaign has and the reason to measure one.
export const SEQUENCE = [
  {day: 0, channel: 'email', template: 4101, name: 'Announcement', audience: 52, engaged: 0.42, clicked: 0.28, lost: 1},
  {day: 1, channel: 'sms', template: 4102, name: 'Early access', audience: 21, engaged: 0.24, lost: 0},
  {day: 3, channel: 'email', template: 4103, name: 'Non-openers', audience: 33, engaged: 0.31, clicked: 0.26, lost: 1},
  {day: 5, channel: 'push', template: 4104, name: 'App exclusive', audience: 26, engaged: 0.38},
  {day: 7, channel: 'email', template: 4105, name: 'Restock', audience: 51, engaged: 0.26, clicked: 0.3, lost: 2},
  {day: 8, channel: 'sms', template: 4106, name: 'Reminder', audience: 20, engaged: 0.18, lost: 1},
  {day: 11, channel: 'push', template: 4107, name: 'Last call', audience: 25, engaged: 0.26},
  {day: 12, channel: 'email', template: 4108, name: 'Last chance', audience: 49, engaged: 0.19, clicked: 0.25, lost: 4},
  {day: 13, channel: 'sms', template: 4109, name: 'Final hours', audience: 19, engaged: 0.13, lost: 2},
];

// What each channel is able to report. The registry gives push no delivery
// receipt and no click event, so push reports two stages where email reports
// six. Model the channel the registry defines rather than padding it out to
// match the others and drawing a hole where the missing stage would be.
//
// `hour` staggers the stages within their day so the timeseries has a shape.
// `code` is a short tag for the idempotency key, which is capped at 64
// characters.
const CHANNELS = {
  email: {
    delivery: 0.94,
    steps: {
      sent: {handle: 'shopify.marketing.email_sent', code: 'snt', hour: 0},
      delivered: {
        handle: 'shopify.marketing.email_delivered',
        code: 'dlv',
        hour: 1,
        extra: {recipient_status: 'delivered'},
      },
      bounced: {
        handle: 'shopify.marketing.email_bounced',
        code: 'bnc',
        hour: 1,
        extra: (index) => ({
          recipient_status: index % 3 === 0 ? 'hard_bounce' : 'soft_bounce',
        }),
      },
      engaged: {handle: 'shopify.marketing.email_opened', code: 'opn', hour: 14},
      clicked: {
        handle: 'shopify.marketing.email_clicked',
        code: 'clk',
        hour: 16,
        extra: {link_domain: 'shop.example.com'},
      },
      lost: {
        handle: 'shopify.marketing.email_unsubscribed',
        code: 'uns',
        hour: 18,
        extra: {recipient_status: 'unsubscribed'},
      },
    },
  },
  sms: {
    delivery: 0.97,
    steps: {
      sent: {
        handle: 'shopify.marketing.sms_sent',
        code: 'snt',
        hour: 0,
        extra: {country_code: 'US'},
      },
      delivered: {
        handle: 'shopify.marketing.sms_delivered',
        code: 'dlv',
        hour: 1,
        extra: {country_code: 'US', recipient_status: 'delivered'},
      },
      engaged: {
        handle: 'shopify.marketing.sms_clicked',
        code: 'clk',
        hour: 4,
        extra: {country_code: 'US', link_domain: 'shop.example.com'},
      },
      lost: {
        handle: 'shopify.marketing.sms_unsubscribed',
        code: 'uns',
        hour: 6,
        extra: {country_code: 'US', recipient_status: 'unsubscribed'},
      },
    },
  },
  push: {
    steps: {
      sent: {
        handle: 'shopify.marketing.push_sent',
        code: 'snt',
        hour: 0,
        extra: (index) => ({
          device_platform: index % 2 === 0 ? 'ios' : 'android',
        }),
      },
      engaged: {
        handle: 'shopify.marketing.push_opened',
        code: 'opn',
        hour: 2,
        extra: (index) => ({
          device_platform: index % 2 === 0 ? 'ios' : 'android',
        }),
      },
    },
  },
};

// One touch becomes up to six stages. Anything the channel can't report, or
// that rounds down to nothing, is left out rather than sent as a zero.
function expand(touch) {
  const channel = CHANNELS[touch.channel];
  const delivered = channel.delivery
    ? Math.round(touch.audience * channel.delivery)
    : touch.audience;
  const engaged = Math.round(delivered * touch.engaged);

  const counts = {
    sent: touch.audience,
    delivered,
    bounced: touch.audience - delivered,
    engaged,
    clicked: Math.round(engaged * (touch.clicked ?? 0)),
    lost: touch.lost ?? 0,
  };

  return Object.entries(counts).flatMap(([name, count]) => {
    const step = channel.steps[name];
    if (!step || count < 1) return [];
    return {
      handle: step.handle,
      code: `d${touch.day}${step.code}`,
      count,
      day: touch.day,
      hour: step.hour,
      attributes: (index) =>
        marketing(
          touch.channel,
          touch.template,
          typeof step.extra === 'function' ? step.extra(index) : step.extra,
        ),
    };
  });
}

// A campaign does two jobs at once: it sells to the list, and it grows the
// list. Lead capture and marketing are separate categories in the registry, but
// both accept campaign_id, so one filter reports both halves together.
const LEAD_CAPTURE = [
  {
    handle: 'shopify.lead_capture.form_submitted',
    code: 'frm',
    count: 14,
    day: 1,
    hour: 0,
    attributes: (index) => ({
      form_id: FORM_ID,
      placement: 'popup',
      capture_type: 'newsletter',
      contact_method: index % 4 === 0 ? 'sms' : 'email',
      // Three people started the form and didn't finish, which is why this
      // count is higher than the leads captured below.
      submission_status: index < 11 ? 'completed' : 'abandoned',
      source: 'online_store',
    }),
  },
  {
    handle: 'shopify.lead_capture.lead_captured',
    code: 'led',
    count: 11,
    day: 1,
    hour: 1,
    attributes: (index) => ({
      lead_id: 7000 + index,
      form_id: FORM_ID,
      capture_type: 'newsletter',
      contact_method: index % 4 === 0 ? 'sms' : 'email',
      consent_state: 'opted_in',
      incentive_id: INCENTIVE_ID,
      source: 'online_store',
    }),
  },
  {
    handle: 'shopify.lead_capture.incentive_issued',
    code: 'inc',
    count: 11,
    day: 2,
    hour: 0,
    attributes: (index) => ({
      incentive_id: INCENTIVE_ID,
      lead_id: 7000 + index,
      form_id: FORM_ID,
      incentive_type: 'discount_code',
      delivery_channel: index % 4 === 0 ? 'sms' : 'email',
      source: 'online_store',
    }),
  },
];

const STAGES = [...LEAD_CAPTURE, ...SEQUENCE.flatMap(expand)];

// The idempotency key is the event's identity. A key that's already been used
// is dropped, payload and all, so re-sending a key with richer attributes keeps
// the original attributes and silently discards the new ones. A real app never
// hits this, because each key belongs to one real send. This one replays the
// same synthetic campaign on every click, so bump this after changing the
// payload to get a fresh set of keys.
const RUN = 'r2';

// Every timestamp this app writes is a UTC instant, and Shopify reads it back
// in the shop's timezone. `2026-07-22T00:00:00Z` is the evening of the 21st in
// New York, so an event stamped at midnight UTC drops out of a ShopifyQL window
// that starts on the 22nd, and an annotation stamped the same way lands a day
// early on the store's charts. Resolve a calendar date to 9am in the shop's own
// timezone rather than guessing a UTC hour that survives most offsets.
export function shopMorning(date, timeZone) {
  const guess = new Date(`${date}T09:00:00Z`);
  if (!timeZone) return guess.getTime();
  const shift =
    new Date(guess.toLocaleString('en-US', {timeZone: 'UTC'})).getTime() -
    new Date(guess.toLocaleString('en-US', {timeZone})).getTime();
  return guess.getTime() + shift;
}

// A minute between recipients, so the largest send still finishes inside the
// hour it started and no event slides into the next day's bucket.
function stageTimestamp(start, day, hour, index) {
  const offset = day * 86400000 + hour * 3600000 + index * 60000;
  return new Date(start + offset).toISOString();
}
// [END campaign-dashboard.app-events-funnel]

// [START campaign-dashboard.app-events-send]
async function sendEvent({token, shopId, stage, campaignId, start, index}) {
  const response = await fetch('https://api.shopify.com/app/unstable/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      shop_id: shopId,
      // Must match the shopify.extension.toml declaration exactly.
      event_handle: stage.handle,
      timestamp: stageTimestamp(start, stage.day, stage.hour, index),
      // Stable for each recipient at each stage, so a retry can't double-count.
      // Capped at 64 characters, so use short codes rather than the handle.
      idempotency_key: `${shopId.split('/').pop()}-${campaignId}-${RUN}-${stage.code}-${index}`,
      // campaign_id is the join. Lead capture and marketing are different
      // categories with different required attributes, and this is the one
      // dimension both accept, so one WHERE clause reports the whole campaign.
      attributes: {campaign_id: campaignId, ...stage.attributes(index)},
    }),
  });

  // 202 means Shopify received the request, not that the event reached
  // analytics. A payload that fails validation is still accepted.
  if (response.status === 202) return {ok: true};
  return {ok: false, status: response.status, body: await response.text()};
}

export async function sendCampaignFunnel({
  shopId,
  campaignId,
  startDate,
  timeZone,
}) {
  const token = await getAppEventsToken();
  const start = shopMorning(startDate, timeZone);
  const accepted = {};
  const failures = [];

  // One request for each event. App Events has no batch endpoint, so a send to
  // a real list is a queue, not a loop in a request handler.
  for (const stage of STAGES) {
    const results = await Promise.all(
      Array.from({length: stage.count}, (_unused, index) =>
        sendEvent({token, shopId, stage, campaignId, start, index}),
      ),
    );
    // Several touches send under the same handle, so this accumulates.
    accepted[stage.handle] =
      (accepted[stage.handle] ?? 0) + results.filter((r) => r.ok).length;
    const failed = results.find((result) => !result.ok);
    if (failed) failures.push(`${stage.handle}: ${failed.status} ${failed.body}`);
  }

  return {accepted, failures};
}
// [END campaign-dashboard.app-events-send]
