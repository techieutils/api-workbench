---
description: Run a team workspace's API tests on every push and pull request, with results in GitHub Actions, GitLab CI, Jenkins, or Azure DevOps.
icon: source-branch-check
---

# Run API tests in CI

This guide runs the same requests and tests your team edits in the app on every push and pull request, so a broken API fails the build. It uses the [command line](../cli.md), a team workspace folder in your repository, and your CI system's JUnit results.

## 1. Put the workspace in your repository

In the app, share a workspace as a [team workspace](../team-workspaces.md) in a folder of your repository, such as `api/`, and commit it. Requests, environments, specifications, and mock servers are plain files there; secrets are not.

Check what CI will run from your own terminal:

```sh
node api-workbench.cjs list ./api
node api-workbench.cjs run ./api -e Staging
```

## 2. Give secrets as variables

Requests in a team folder cannot use the app's vault in CI. Write each secret as a variable in the request, such as `Bearer {{api_token}}` in its **Auth** tab, and give its value from your CI system's secret store with `-v api_token`. Without `=`, `-v` reads the environment variable of the same name, so the secret never appears in the command or the log.

## 3. Add the pipeline

Each setup below downloads a pinned release of the command line, checks it against the release's checksums, runs the tests, and publishes the JUnit report even when tests fail. Change `v1.2.0` to the release you use.

### GitHub Actions

```yaml
name: API tests
on: [push, pull_request]
jobs:
  api:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      checks: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Get API Workbench
        run: |
          base=https://github.com/techieutils/api-workbench/releases/download/v1.2.0
          curl -fsSLO "$base/api-workbench-cli.cjs" -O "$base/SHA256SUMS"
          sha256sum --check --ignore-missing SHA256SUMS
      - name: Run API tests
        env:
          api_token: ${{ secrets.STAGING_API_TOKEN }}
        run: node api-workbench-cli.cjs run ./api -e Staging -v api_token --report-junit api-results.xml
      - name: Show results
        if: always()
        uses: dorny/test-reporter@v2
        with:
          name: API tests
          path: api-results.xml
          reporter: java-junit
```

### GitLab CI

```yaml
api-tests:
  image: node:22
  variables:
    api_token: $STAGING_API_TOKEN
  script:
    - base=https://github.com/techieutils/api-workbench/releases/download/v1.2.0
    - curl -fsSLO "$base/api-workbench-cli.cjs" -O "$base/SHA256SUMS"
    - sha256sum --check --ignore-missing SHA256SUMS
    - node api-workbench-cli.cjs run ./api -e Staging -v api_token --report-junit api-results.xml
  artifacts:
    when: always
    reports:
      junit: api-results.xml
```

### Jenkins

```groovy
pipeline {
  agent { docker { image 'node:22' } }
  environment {
    api_token = credentials('staging-api-token')
  }
  stages {
    stage('API tests') {
      steps {
        sh '''
          base=https://github.com/techieutils/api-workbench/releases/download/v1.2.0
          curl -fsSLO "$base/api-workbench-cli.cjs" -O "$base/SHA256SUMS"
          sha256sum --check --ignore-missing SHA256SUMS
          node api-workbench-cli.cjs run ./api -e Staging -v api_token --report-junit api-results.xml
        '''
      }
    }
  }
  post {
    always { junit 'api-results.xml' }
  }
}
```

### Azure DevOps

```yaml
pool:
  vmImage: ubuntu-latest
steps:
  - task: UseNode@1
    inputs:
      version: 22.x
  - script: |
      base=https://github.com/techieutils/api-workbench/releases/download/v1.2.0
      curl -fsSLO "$base/api-workbench-cli.cjs" -O "$base/SHA256SUMS"
      sha256sum --check --ignore-missing SHA256SUMS
      node api-workbench-cli.cjs run ./api -e Staging -v api_token --report-junit api-results.xml
    displayName: API tests
    env:
      api_token: $(STAGING_API_TOKEN)
  - task: PublishTestResults@2
    condition: always()
    inputs:
      testResultsFormat: JUnit
      testResultsFiles: api-results.xml
```

Any other system works the same way: run the command, and publish the file `--report-junit` writes with the system's JUnit step. The command exits with `1` when a test fails and `2` when the run could not start, such as a mistyped environment name, so the build fails in both cases.

## 4. Go further

**Check the specification.** `spec lint` exits with `1` when an OpenAPI document has an error, so a broken specification fails the build before any request is sent:

```sh
node api-workbench-cli.cjs spec lint api/specs/orders.yaml
```

**Test against a mock.** Start one of the workspace's [mock servers](../mock-servers.md) in the background, wait for it, and run the tests against it, such as with an environment whose `base_url` is the mock's address:

```sh
node api-workbench-cli.cjs mock start "Orders mock" --dir ./api --port 4010 &
until curl -s -o /dev/null http://127.0.0.1:4010/; do sleep 0.2; done
node api-workbench-cli.cjs run ./api -e Mock --report-junit api-results.xml
kill %1
```

**Run a short load test.** A few seconds under load catches a slow endpoint before release. `--p95` and `--max-error-rate` set the limits, and the JUnit report has a test case for each:

```sh
node api-workbench-cli.cjs run ./api -c Orders -e Staging -v api_token \
  --duration 20 --concurrency 5 --p95 400 --max-error-rate 1 --report-junit load-results.xml
```

**Run request scripts.** When requests have [scripts](../scripts.md), add `--allow-scripts` to run them — the run stops with a reason until you choose it or `--skip-scripts`. Scripts in your own repository are reviewed in pull requests like any other code.

**Run a smoke test on every push.** [Tag](../requests.md#tags) the requests that matter most `smoke`, and run only those on each push, keeping the full suite for the nightly build: `node api-workbench-cli.cjs run ./api -e Staging --tag smoke`. Add `--exclude-tag slow` to leave out long requests. A mistyped tag stops the run with the tags there are, so a typo never runs nothing and passes.

**Run with data.** `--data users.csv` runs the requests once per row, with each column as a `{{variable}}`. See [Run with a data file](../runner.md#run-with-a-data-file).

**Keep a JSON report.** `--report-json report.json` records every request's status, time, and tests, and the run's latency figures, for dashboards or comparing runs. Save it as a build artifact.

> [!TIP]
> Run only part of the workspace with `-c Orders` or `-r "Create order"`, stop at the first failure with `--bail`, and show only failures with `--quiet`. See [Run tests](../cli.md#run-tests) for every option.
