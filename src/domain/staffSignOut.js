export async function finishStaffSession({ isOwner, recordLogout, signOut, onRecordError }) {
  if (!isOwner) {
    try { await recordLogout(); }
    catch (error) { onRecordError(error); }
  }
  // An unavailable attendance service must never trap a user in an authenticated app.
  await signOut();
}
