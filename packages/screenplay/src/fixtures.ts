import { DEFAULT_DOCUMENT_SETTINGS, type Screenplay } from './index.js';

export const screenplayFixture: Screenplay = {
  schemaVersion: 1,
  id: 'e1f8e6a8-e7bb-42bd-b2fa-0805d4064201',
  title: 'The Last Stop',
  documentSettings: DEFAULT_DOCUMENT_SETTINGS,
  titlePages: [
    {
      id: 'd2df4da9-1c58-421d-86ba-9988a805eea4',
      title: 'THE LAST STOP',
      authors: ['Morgan Vale'],
      credit: 'Written by',
      draftDate: 'August 2026',
      contact: ['morgan@example.test'],
    },
  ],
  blocks: [
    {
      id: '2175a1b6-8d05-4e6e-bac7-e471e8df33a1',
      type: 'scene_heading',
      text: 'INT. UNION STATION - NIGHT',
      sceneNumber: '1',
    },
    {
      id: 'ba53c2dc-10a6-46d7-a409-9aabbff7cf5d',
      type: 'action',
      text: 'Rain presses against the glass ceiling. ADA waits beside a silent departures board.',
    },
    {
      id: '5e4c810d-75d9-4b2e-a1a2-0f7cb30fd77b',
      type: 'character',
      text: 'ADA',
    },
    {
      id: 'c3ca98bb-6720-45b1-85ae-8c851ba2f5be',
      type: 'parenthetical',
      text: '(into her phone)',
    },
    {
      id: '0f2b5f3c-6d17-4f18-8d95-90b06e93e13a',
      type: 'dialogue',
      text: 'I am at the last stop. If you are coming, come now.',
    },
    {
      id: 'd01faf47-64e7-4f7c-853a-3c6ace1464ad',
      type: 'transition',
      text: 'CUT TO:',
    },
    {
      id: '7e00a5b4-e629-42ea-98e7-705ff5ce46b1',
      type: 'scene_heading',
      text: 'EXT. UNION STATION - CONTINUOUS',
      sceneNumber: '2',
    },
    {
      id: 'b4f2a758-8f86-465e-9a9e-485612244317',
      type: 'shot',
      text: 'CLOSE ON the arrival clock as it changes to midnight.',
    },
    {
      id: '6d292544-0da7-4d70-b4fc-1e74f8419f8e',
      type: 'dual_dialogue',
      left: {
        id: '414a6e41-ef46-4494-9973-1be5e1c5a058',
        blocks: [
          { id: 'd5a7f0f4-235c-4d3c-8385-b5f7a3a97720', type: 'character', text: 'ADA' },
          { id: '76b460a1-1e89-45d9-89bd-f006ae87d0d7', type: 'dialogue', text: 'You made it.' },
        ],
      },
      right: {
        id: '7bb08610-61a9-44d4-8c9e-14c3bc3e52c4',
        blocks: [
          { id: '311e1d44-8a79-42c0-a8f4-ee3a3ec2ddf7', type: 'character', text: 'MILES' },
          {
            id: 'e6e0ff5d-988e-488d-9169-9c90bf9f97e4',
            type: 'dialogue',
            text: 'The train was late.',
          },
        ],
      },
    },
    { id: '0a5e4fa5-6204-4ab0-b4bb-8f5a30af1cb1', type: 'page_break' },
  ],
  annotations: [
    {
      id: '6280e5ea-d459-49bc-8e81-ea5a97654bdb',
      type: 'note',
      text: 'Confirm station access.',
      anchor: {
        blockId: 'ba53c2dc-10a6-46d7-a409-9aabbff7cf5d',
        startOffset: 0,
        endOffset: 4,
      },
    },
  ],
};

export const minimalScreenplayFixture: Screenplay = {
  schemaVersion: 1,
  id: 'bc1527f9-5cd9-4e76-a3b4-271b508c3a5d',
  title: 'Untitled Screenplay',
  documentSettings: DEFAULT_DOCUMENT_SETTINGS,
  titlePages: [],
  blocks: [],
  annotations: [],
};
