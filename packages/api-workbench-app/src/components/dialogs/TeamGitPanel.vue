<script setup lang="ts">
import { computed, onMounted } from 'vue';
import type { GitChangeKind } from '@techieutils/api-workbench-common/types';
import { useTeamGitStore } from '../../stores/team-git';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';
import UiIconButton from '../ui/UiIconButton.vue';

/**
 * Git sync for the open team workspace: connect its folder to GitHub, GitLab, Bitbucket, or any
 * Git remote, then commit, pull, push, or sync. Shown in the workspace manager's details.
 */
const props = defineProps<{ disabled?: boolean }>();
const store = useTeamGitStore();
const git = store.git;
const status = computed(() => git.status);
const locked = computed(() => props.disabled || Boolean(git.busy) || git.loading);
const SHOWN_CHANGES = 8;
const KIND_LABELS: Record<GitChangeKind, string> = {
  added: 'Added',
  modified: 'Changed',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'New',
  conflicted: 'Conflict',
};
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const summary = computed(() => {
  const value = status.value;
  if (!value?.repository) return '';
  const parts = [
    value.changeCount && `${plural(value.changeCount, 'changed file')}`,
    value.ahead && `${plural(value.ahead, 'commit')} to push`,
    value.behind && `${plural(value.behind, 'commit')} to pull`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Up to date with the last pull';
});
const busyLabel = (kind: string, label: string, working: string) =>
  git.busy === kind ? working : label;

function setRemote(event: Event): void {
  git.remoteURL = (event.target as HTMLInputElement).value;
  git.remoteError = '';
}
function setMessage(event: Event): void {
  git.message = (event.target as HTMLInputElement).value;
}
onMounted(() => void store.refresh());
</script>

<template>
  <section
    class="team-git"
    aria-labelledby="team-git-title"
    data-team-git
    :aria-busy="Boolean(git.busy) || git.loading"
  >
    <div class="team-git-heading">
      <h4 id="team-git-title"><MdiIcon name="git" /> Git sync</h4>
      <UiIconButton
        label="Check Git status again"
        icon="refresh"
        data-team-git-refresh
        :disabled="locked"
        @click="store.refresh()"
      />
    </div>
    <p v-if="git.error" class="form-error" role="alert" data-team-git-error>{{ git.error }}</p>
    <p v-if="!status && git.loading" class="team-git-note">Checking Git…</p>
    <p v-else-if="status && !status.available" class="team-git-note" data-team-git-missing>
      Install <strong>Git</strong> to sync this folder with GitHub, GitLab, Bitbucket, or any Git
      server. Then check again.
    </p>
    <template v-else-if="status">
      <div
        v-if="git.conflicts.length"
        class="team-git-conflicts"
        role="alert"
        data-team-git-conflicts
      >
        <strong
          ><MdiIcon name="source-merge" /> These files changed both here and on the remote</strong
        >
        <ul>
          <li v-for="file in git.conflicts" :key="file">
            <code>{{ file }}</code>
          </li>
        </ul>
        <p>
          The pull was undone, so nothing is half-merged. Choose whose changes to keep in these
          files; changes elsewhere are merged either way.
        </p>
        <div class="team-git-actions">
          <UiButton
            label="Keep mine"
            data-team-git-keep-mine
            :disabled="locked"
            @click="store.resolve('mine')"
          /><UiButton
            label="Take theirs"
            data-team-git-take-theirs
            :disabled="locked"
            @click="store.resolve('theirs')"
          /><UiButton
            label="Decide later"
            variant="ghost"
            :disabled="locked"
            @click="store.dismissConflicts()"
          />
        </div>
      </div>
      <dl v-if="status.repository" class="team-git-facts">
        <div>
          <dt>Branch</dt>
          <dd data-team-git-branch>
            <MdiIcon name="source-branch" />
            {{ status.branch ?? 'No branch checked out' }}
            <span v-if="status.upstream" class="team-git-muted">→ {{ status.upstream }}</span>
          </dd>
        </div>
        <div v-if="status.remote">
          <dt>Remote</dt>
          <dd>
            <code data-team-git-remote>{{ status.remote }}</code>
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd data-team-git-summary>{{ summary }}</dd>
        </div>
      </dl>
      <ul v-if="status.changes.length" class="team-git-changes" aria-label="Changed files">
        <li v-for="change in status.changes.slice(0, SHOWN_CHANGES)" :key="change.path">
          <span :class="['team-git-kind', `team-git-kind-${change.kind}`]">{{
            KIND_LABELS[change.kind]
          }}</span
          ><code>{{ change.path }}</code>
        </li>
        <li v-if="status.changeCount > SHOWN_CHANGES" class="team-git-muted">
          and {{ status.changeCount - SHOWN_CHANGES }} more
        </li>
      </ul>
      <form
        v-if="!status.repository || !status.remote"
        class="team-git-form"
        data-team-git-connect-form
        @submit.prevent="store.connect()"
      >
        <p class="team-git-note">
          Create an empty repository on GitHub, GitLab, or Bitbucket and paste its URL. Git signs in
          with your SSH key or credential manager; the app never sees a token.
        </p>
        <label class="form-field" for="team-git-remote"
          ><span>Repository URL</span
          ><input
            id="team-git-remote"
            class="field-input"
            spellcheck="false"
            autocomplete="off"
            placeholder="git@github.com:team/api.git"
            aria-describedby="team-git-remote-error"
            :aria-invalid="Boolean(git.remoteError)"
            :value="git.remoteURL"
            :disabled="locked"
            @input="setRemote"
        /></label>
        <p id="team-git-remote-error" class="form-error" aria-live="polite">
          {{ git.remoteError }}
        </p>
        <UiButton
          type="submit"
          variant="primary"
          icon="cloud-upload-outline"
          data-team-git-connect
          :label="busyLabel('connect', 'Connect and push', 'Connecting…')"
          :disabled="locked"
        />
      </form>
      <form v-else class="team-git-form" data-team-git-sync-form @submit.prevent="store.sync()">
        <label class="form-field" for="team-git-message"
          ><span>Commit message</span
          ><input
            id="team-git-message"
            class="field-input"
            maxlength="2000"
            autocomplete="off"
            placeholder="Update API collections"
            :value="git.message"
            :disabled="locked"
            @input="setMessage"
        /></label>
        <div class="team-git-actions">
          <UiButton
            icon="source-commit"
            data-team-git-commit
            :label="busyLabel('commit', 'Commit', 'Committing…')"
            :disabled="locked || !status.changeCount"
            @click="store.commit()"
          /><UiButton
            icon="cloud-download-outline"
            data-team-git-pull
            :label="busyLabel('pull', 'Pull', 'Pulling…')"
            :disabled="locked"
            @click="store.pull()"
          /><UiButton
            icon="cloud-upload-outline"
            data-team-git-push
            :label="busyLabel('push', 'Push', 'Pushing…')"
            :disabled="locked"
            @click="store.push()"
          /><UiButton
            type="submit"
            variant="primary"
            icon="sync"
            data-team-git-sync
            :label="busyLabel('sync', 'Sync', 'Syncing…')"
            :disabled="locked"
          />
        </div>
        <p class="team-git-note">
          Sync commits your changes, pulls teammates’ commits, and pushes. Secrets are never in the
          folder, so they are never committed.
        </p>
      </form>
    </template>
  </section>
</template>
