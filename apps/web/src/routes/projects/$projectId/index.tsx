import { createFileRoute } from '@tanstack/react-router';
import { ProjectPage } from '../../../WorkspaceApp.js';

export const Route = createFileRoute('/projects/$projectId/')({ component: ProjectPage });
