import { createFileRoute } from '@tanstack/react-router';
import { SignInPage } from '../WorkspaceApp.js';

export const Route = createFileRoute('/sign-in')({ component: SignInPage });
