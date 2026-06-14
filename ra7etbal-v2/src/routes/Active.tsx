import { Navigate } from "react-router-dom";
export default function Active() {
  return <Navigate to="/updates?tab=needs-you" replace />;
}
