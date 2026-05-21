export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { taskId } = req.query;

  if (!taskId) {
    return res.status(400).json({ error: 'Task ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const response = await fetch(
      supabaseUrl + '/rest/v1/tasks?id=eq.' + taskId + '&select=id,user_id,description,assigned_to,status,confirmed_at',
      {
        headers: {
          'apikey': serviceKey,
          'Authorization': 'Bearer ' + serviceKey,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data || data.length === 0) {
      return res.status(404).json({ error: 'This confirmation link is invalid or expired.' });
    }

    const task = data[0];
    const ownerPhone = await findOwnerPhone({
      supabaseUrl,
      serviceKey,
      userId: task.user_id
    });

    return res.status(200).json({
      id: task.id,
      description: task.description,
      assignedTo: task.assigned_to,
      status: task.status,
      confirmedAt: task.confirmed_at,
      ownerPhone
    });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

async function findOwnerPhone({ supabaseUrl, serviceKey, userId }) {
  if (!userId) return null;

  const response = await fetch(
    supabaseUrl +
      '/rest/v1/people?user_id=eq.' +
      encodeURIComponent(userId) +
      '&select=name,role,phone',
    {
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) return null;
  const people = await response.json();
  if (!Array.isArray(people)) return null;

  const owner = people.find((person) => {
    const name = String(person.name || '').trim().toLowerCase();
    const role = String(person.role || '').trim().toLowerCase();
    return (name === 'boss' || role === 'boss') && person.phone;
  });

  return owner ? owner.phone : null;
}
