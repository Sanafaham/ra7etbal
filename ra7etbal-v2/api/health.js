export default function handler(_req, res) {
  res.status(200).json({ ok: true, app: "ra7etbal-v2", time: new Date().toISOString() });
}
