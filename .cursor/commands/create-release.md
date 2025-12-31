# Create GitHub Release from Changes Since Last Tag

Create a GitHub release based on commits since the previous tag. Generate release notes, create the release using the GitHub CLI, and verify the post-release workflow status.

## Gather Information

1. **Get the new version** from `package.json` version key
2. **Get the previous tag** using `git describe --tags --abbrev=0`
3. **Get the target commit SHA** using `git rev-parse HEAD`

## Steps

1. **Get Git Diff:**
   Look at all the changes between the previous tag and HEAD:
   ```bash
   git --no-pager diff <PREVIOUS_REF>
   ```

2. **Format Release Notes:**
   Take the raw git diff and format it into Markdown using this structure:
   ```markdown
   # iOS Simulator MCP <NEW_VERSION>

   ## Features 
   - **Feature Name:** Description...

   ## Improvements
   - **Improvement Name:** Description...

   ## Documentation
   - **Doc Update:** Description...

   ## Build
   - **Version Bump:** Updated the project version to <NEW_VERSION>.
   ```

3. **Create Temporary Notes File:**
   Save the formatted markdown notes into `TEMP.md`. This avoids shell quoting/escaping issues.

   ⚠️ **STOP and ask for review before proceeding.** Creating a release will trigger a GitHub action that is too fast to cancel if triggered by mistake.

4. **Create GitHub Release:**
   Use the `gh` CLI to create the release:
   ```bash
   gh release create <NEW_VERSION> --target <TARGET_SHA> --title "<RELEASE_TITLE>" --notes-file TEMP.md --latest
   ```
   
   For the title, use format: `<NEW_VERSION> - <SUMMARY>` where summary is the most significant change in 5 words or less. Consider adding an emoji at the end if it matches well.

5. **Clean Up:**
   Remove the temporary notes file:
   ```bash
   rm TEMP.md
   ```

6. **Verify Workflow Status:**
   Check the status of the workflow run triggered by the release:
   ```bash
   gh run list --limit 1 --json name,status,conclusion,event,url --jq '.[0]' | cat
   ```
   The `conclusion` field should be `success`.

