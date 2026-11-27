import React, { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { callFinancial } from '../../services/functions';
import { publicError } from '../../services/errors';
import { businessDate } from '../../domain/dates';
import StaffActivityView from './StaffActivityView';

export default function StaffActivity() {
  const { workspaceId, isOwner } = useApp();
  const [start, setStart] = useState(businessDate);
  const [end, setEnd] = useState(businessDate);
  const [rangeMode, setRangeMode] = useState(false);
  const [period, setPeriod] = useState(() => ({ start: businessDate(), end: businessDate(), attempt: 0 }));
  const [state, setState] = useState(null);
  const key = JSON.stringify([workspaceId, period]);
  useEffect(() => {
    if (!isOwner || !workspaceId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setPeriod(previous => ({ ...previous, attempt: previous.attempt + 1 }));
    }, 60000);
    return () => clearInterval(timer);
  }, [isOwner, workspaceId]);
  useEffect(() => {
    if (!isOwner || !workspaceId) return;
    let active = true;
    callFinancial('getStaffSummary', { workspace: workspaceId, start: period.start, end: period.end })
      .then(report => { if (active) setState({ key, report }); })
      .catch(error => { if (active) setState({ key, error: error?.code === 'functions/resource-exhausted' ? 'Wait a minute before refreshing the staff report.' : publicError(error, 'Could not load staff activity. Check the connection and refresh.') }); });
    return () => { active = false; };
  }, [isOwner, workspaceId, key, period.start, period.end]);
  if (!isOwner) return null;
  return <StaffActivityView start={start} end={end} rangeMode={rangeMode}
    onStartChange={value => {
      setStart(value);
      if (!rangeMode) {
        setEnd(value);
        setPeriod(previous => ({ start: value, end: value, attempt: previous.attempt + 1 }));
      }
    }} onEndChange={setEnd}
    onRangeChange={() => {
      if (rangeMode) {
        const day = start || businessDate();
        setStart(day);
        setEnd(day);
        setPeriod(previous => ({ start: day, end: day, attempt: previous.attempt + 1 }));
      }
      setRangeMode(previous => !previous);
    }}
    loading={!state || state.key !== key} error={state?.key === key ? state.error : null} report={state?.key === key ? state.report : null}
    onApply={event => { event.preventDefault(); setPeriod(previous => ({ start, end, attempt: previous.attempt + 1 })); }}
    onToday={() => { const today = businessDate(); setStart(today); setEnd(today); setRangeMode(false); setPeriod(previous => ({ start: today, end: today, attempt: previous.attempt + 1 })); }} />;
}
