export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { taskId, confirmedBy } = req.body;

  if (!taskId) {
    return res.status(400).json({ error: 'Task ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const headers = {
    'apikey': serviceKey,
    'Authorization': 'Bearer ' + serviceKey,
    'Content-Type': 'application/json'
  };

  try {
    // Fetch the task first
    const fetchRes = await fetch(
      supabaseUrl + '/rest/v1/tasks?id=eq.' + taskId + '&select=id,status,description',
      { headers }
    );

    const tasks = await fetchRes.json();

    if (!fetchRes.ok || !tasks || tasks.length === 0) {
      return res.status(404).json({ error: 'This confirmation link is invalid or expired.' });
    }

    const task = tasks[0];

    // Already done
    if (task.status === 'done') {
      return res.status(200).json({ already_done: true, description: task.description });
    }

    const now = new Date().toISOString();

    // Update task to done
    const updateRes = await fetch(
      supabaseUrl + '/rest/v1/tasks?id=eq.' + taskId,
      {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          status: 'done',
          confirmed_at: now,
          confirmed_by: confirmedBy || null
        })
      }
    );

    if (!updateRes.ok) {
      return res.status(500).json({ error: 'Could not confirm task. Please try again.' });
    }

    // Insert confirmation record
    await fetch(
      supabaseUrl + '/rest/v1/confirmations',
      {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          task_id: taskId,
          confirmed_at: now,
          confirmed_by: confirmedBy || null,
          source: 'confirmation_link'
        })
      }
    );

    return res.status(200).json({ success: true, description: task.description });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
