set -euo pipefail
if [ "$PRESET" != pull-request-and-branch ]; then
  echo '::error::The trusted-contributor workflow requires preset: pull-request-and-branch'
  exit 1
fi
if [ "$EVENT_NAME" != push ] || [ "$REF" != "refs/heads/$BRANCH" ]; then
  exit 0
fi
if ! pulls=$(gh api --paginate --slurp "repos/$REPOSITORY/commits/$SHA/pulls"); then
  echo '::warning::Could not resolve the merged pull request; branch outputs will be built'
  echo 'pull-request=' >> "$GITHUB_OUTPUT"
  exit 0
fi
if ! number=$(jq -r --arg sha "$SHA" --arg id "$REPOSITORY_ID" --arg branch "$BRANCH" '
  [ .[][] | select(.merged_at != null and .merge_commit_sha == $sha and
      (.head.repo.id | tostring) == $id and (.base.repo.id | tostring) == $id and .base.ref == $branch) ]
  | unique_by(.number)
  | if length == 1 then .[0].number else "" end
' <<< "$pulls"); then
  echo '::warning::Could not read the merged pull request response; branch outputs will be built'
  echo 'pull-request=' >> "$GITHUB_OUTPUT"
  exit 0
fi
if [[ ! "$number" =~ ^[1-9][0-9]*$ ]]; then
  echo 'No unique merged pull request matches this commit; branch outputs will be built'
  number=''
fi
echo "pull-request=$number" >> "$GITHUB_OUTPUT"
