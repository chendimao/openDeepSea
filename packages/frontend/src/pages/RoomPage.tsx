import { useParams } from 'react-router-dom';
import { RoomWorkbench } from '../components/room/RoomWorkbench';

export { upsertAgentRun } from '../components/room/RoomWorkbench';

export function RoomPage(): JSX.Element {
  const { projectId = '', roomId = '' } = useParams();
  return <RoomWorkbench projectId={projectId} roomId={roomId} />;
}
