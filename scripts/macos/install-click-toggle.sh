#!/usr/bin/env bash
# Registers coding-buddy:// with macOS: cmd+clicking the buddy's name runs toggle-expanded.sh, or
# bubble-click.sh while a reaction's bubble can be closed or reopened.
set -euo pipefail

app="$HOME/Applications/Coding Buddy Toggle.app"
toggle="${1:-$HOME/.claude-buddy/app/statusline/toggle-expanded.sh}"
bubble_click="$(dirname "$toggle")/bubble-click.sh"
plist="$app/Contents/Info.plist"
source_file=$(mktemp -t coding-buddy-toggle)

# Any web page can open coding-buddy:// links: the URL only picks a script, and bubble-click.sh gets
# it as one quoted argument to validate.
cat > "$source_file" <<EOF
on open location theURL
	if theURL is "coding-buddy://toggle" then
		do shell script "/bin/bash " & quoted form of "$toggle"
	else if theURL starts with "coding-buddy://reopen/" or theURL starts with "coding-buddy://close/" then
		do shell script "/bin/bash " & quoted form of "$bubble_click" & " " & quoted form of theURL
	end if
end open location
EOF

mkdir -p "$HOME/Applications"
osascript -e 'tell application id "dev.coding-buddy.toggle" to quit' 2>/dev/null || true
rm -rf "$app"
# Stay-open (-s): a relaunch per click takes a second and drops clicks made while it quits.
osacompile -s -o "$app" "$source_file"
rm -f "$source_file"

/usr/libexec/PlistBuddy \
    -c "Add :CFBundleIdentifier string dev.coding-buddy.toggle" \
    -c "Add :LSUIElement bool true" \
    -c "Add :CFBundleURLTypes array" \
    -c "Add :CFBundleURLTypes:0 dict" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLName string coding-buddy" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string coding-buddy" \
    "$plist"

# Editing Info.plist breaks osacompile's signature; an unsigned edit is refused at launch.
codesign --force --deep --sign - "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
echo "Registered coding-buddy:// -> $toggle, $reopen"
