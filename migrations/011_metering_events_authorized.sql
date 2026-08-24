-- 011: retire `billed` as a money claim.
--
-- `metering_events.billed` was written at authorize time
-- (result.allowed && !result.failSafe). No payment moved. The 007 comment
-- said it recorded a Stripe post; Stripe left this path. The column's name,
-- its documented meaning, and its write disagreed.
--
-- Readers must use `authorized`. Whether a call was paid is a different
-- fact with a different writer. No paid column is created here: an absent
-- number forces a decision; an invented billed figure does not.
--
-- Retirement of the `billed` identifier: the column is renamed, the index
-- is renamed, and JSON consumers must read totals.authorized. The
-- command-center Revenue Meter still reads totals.billed — that is a
-- PROPERTY change request filed with this card, not a silent alias.

ALTER TABLE metering_events RENAME COLUMN billed TO authorized;
ALTER INDEX IF EXISTS idx_metering_events_billed RENAME TO idx_metering_events_authorized;
