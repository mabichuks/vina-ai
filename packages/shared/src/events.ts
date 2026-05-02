import { z } from 'zod';
import { AlertSchema } from './schemas/alert.js';
import { ApplicationEventSchema } from './schemas/application.js';
import { ChatMessageSchema } from './schemas/chat.js';

const isoDate = z.iso.datetime();

export const EVENTS = {
  JOBS_UPDATED: 'jobs:updated',
  APPLICATION_UPDATED: 'application:updated',
  APPLICATION_EVENT: 'application:event',
  APPLICATION_READY_FOR_MANUAL_APPLY: 'application:ready_for_manual_apply',
  APPLICATION_APPLIED_MANUALLY: 'application:applied_manually',
  ALERT_CREATED: 'alert:created',
  ALERT_RESOLVED: 'alert:resolved',
  ALERT_DISMISSED: 'alert:dismissed',
  CHAT_TOKEN: 'chat:token',
  CHAT_MESSAGE: 'chat:message',
  SITE_LOGIN_STATUS: 'site:login_status',
  SYSTEM_STATUS: 'system:status',
  QUEUE_UPDATED: 'queue:updated',
} as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

const JobsUpdatedPayload = z.object({ ids: z.array(z.string()) });
const ApplicationUpdatedPayload = z.object({ id: z.string(), status: z.string() });
const ApplicationEventPayload = ApplicationEventSchema.pick({
  application_id: true,
  kind: true,
  payload: true,
});
const ApplicationReadyForManualApplyPayload = z.object({
  application_id: z.string(),
  external_apply_url: z.url(),
  tailored_cv_path: z.string(),
});
const ApplicationAppliedManuallyPayload = z.object({
  application_id: z.string(),
  applied_at: isoDate,
});
const AlertCreatedPayload = AlertSchema;
const AlertResolvedPayload = z.object({ id: z.string() });
const AlertDismissedPayload = z.object({ id: z.string() });
const ChatTokenPayload = z.object({ message_id: z.string(), token: z.string() });
const ChatMessagePayload = ChatMessageSchema;
const SiteLoginStatusPayload = z.object({
  login_id: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  reason: z.string().optional(),
});
const SystemStatusPayload = z.object({
  paused: z.boolean(),
  mode: z.string(),
  approval: z.string(),
  active_llm_provider_id: z.string().nullable(),
});
const QueueUpdatedPayload = z.object({
  pending: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
});

export const EVENT_PAYLOADS = {
  [EVENTS.JOBS_UPDATED]: JobsUpdatedPayload,
  [EVENTS.APPLICATION_UPDATED]: ApplicationUpdatedPayload,
  [EVENTS.APPLICATION_EVENT]: ApplicationEventPayload,
  [EVENTS.APPLICATION_READY_FOR_MANUAL_APPLY]: ApplicationReadyForManualApplyPayload,
  [EVENTS.APPLICATION_APPLIED_MANUALLY]: ApplicationAppliedManuallyPayload,
  [EVENTS.ALERT_CREATED]: AlertCreatedPayload,
  [EVENTS.ALERT_RESOLVED]: AlertResolvedPayload,
  [EVENTS.ALERT_DISMISSED]: AlertDismissedPayload,
  [EVENTS.CHAT_TOKEN]: ChatTokenPayload,
  [EVENTS.CHAT_MESSAGE]: ChatMessagePayload,
  [EVENTS.SITE_LOGIN_STATUS]: SiteLoginStatusPayload,
  [EVENTS.SYSTEM_STATUS]: SystemStatusPayload,
  [EVENTS.QUEUE_UPDATED]: QueueUpdatedPayload,
} as const satisfies Record<EventName, z.ZodTypeAny>;

export type EventPayloads = {
  [K in EventName]: z.infer<(typeof EVENT_PAYLOADS)[K]>;
};

export type EventPayloadFor<T extends EventName> = EventPayloads[T];

export const EventEnvelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
  timestamp: isoDate,
});
