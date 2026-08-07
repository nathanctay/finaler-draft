import { createFileRoute } from '@tanstack/react-router';
import { ProjectsPage } from '../../WorkspaceApp.js';

export const Route = createFileRoute('/projects/')({ component: ProjectsPage });
