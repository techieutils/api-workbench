import { describe, expect, it } from 'vitest';
import { request, workspaceWith } from '../test/workspace';

describe('workspace store', () => {
  it('resolves variables from a data row first, then the environment, then built-ins', () => {
    const workspace = workspaceWith([request('List users', 'Users')]);
    expect(workspace.resolve('{{base_url}}/users')).toBe('https://api.example.test/users');
    // Switched-off variables and unknown names stay as written.
    expect(workspace.resolve('{{off}} {{nope}}')).toBe('{{off}} {{nope}}');
    expect(workspace.resolve('{{$guid}}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      workspace.withDataRow({ base_url: 'https://row.example.test' }, () =>
        workspace.resolve('{{ base_url }}/a'),
      ),
    ).toBe('https://row.example.test/a');
    // The row applies only inside the call.
    expect(workspace.resolve('{{base_url}}')).toBe('https://api.example.test');
  });

  it('a data row column named like an Object member is still a value', () => {
    const workspace = workspaceWith([request('A', 'Users')]);
    expect(workspace.withDataRow({}, () => workspace.resolve('{{constructor}}'))).toBe(
      '{{constructor}}',
    );
  });

  it('finds the open request, and says when there is none', () => {
    const first = request('First', 'Users');
    const workspace = workspaceWith([first, request('Second', 'Users')]);
    expect(workspace.current().id).toBe(first.id);
    workspace.state.active = 'missing';
    expect(() => workspace.current()).toThrow('No active request');
  });

  it('lists only the environment variables that are on and named', () => {
    const workspace = workspaceWith([request('A', 'Users')]);
    expect(workspace.activeVariables().map((variable) => variable.key)).toEqual(['base_url']);
  });

  it('saves no responses unless the setting keeps them', () => {
    const sent = request('A', 'Users', {
      response: {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: 'secret',
        time: 1,
        size: 6,
        url: 'x',
      },
    });
    const workspace = workspaceWith([sent]);
    expect(workspace.persistedWorkspace().requests[0].response).toBeNull();
    // The workspace itself keeps it for this session.
    expect(workspace.state.requests[0].response).not.toBeNull();
  });
});
