import { getTraceProcessorService } from '../services/traceProcessorService';

async function testAndroidTrace() {
  const tp = getTraceProcessorService();
  const traceId = await tp.loadTraceFromFilePath('../perfetto/test/data/android_postboot_unlock.pftrace');
  
  try {
    // Check if android_frames table exists
    const result = await tp.query(traceId, "SELECT COUNT(*) as count FROM android_frames LIMIT 1");
    console.log('✓ android_frames table exists, count:', result.rows[0][0]);
  } catch (e: any) {
    console.log('✗ android_frames table does not exist:', e.message?.substring(0, 200));
  }
  
  await tp.deleteTrace(traceId);
}

testAndroidTrace().catch(console.error);
