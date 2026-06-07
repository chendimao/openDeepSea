import { Navigate, useParams } from 'react-router-dom';
import { ImageGenerationShell } from '../image-generation/ImageGenerationShell';

export function ImageWorkbenchPage(): JSX.Element {
  const { projectId } = useParams();
  if (!projectId) return <Navigate to="/" replace />;
  return <ImageGenerationShell projectId={projectId} />;
}
