import { getTraceProcessorService } from '../services/traceProcessorService';

async function checkTables() {
  const tp = getTraceProcessorService();
  const traceId = await tp.loadTraceFromFilePath('../perfetto/test/data/android_postboot_unlock.pftrace');
  
  try {
    // Check what tables exist
    const result = await tp.query(traceId, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%frame%' ORDER BY name");
    console.log('Frame-related tables:');
    result.rows.forEach(row => console.log('  -', row[0]));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 200));
  }
  
  await tp.deleteTrace(traceId);
}

checkTables().catch(console.error);
