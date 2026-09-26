#!/usr/bin/env bash
# Registers coding-buddy:// with macOS so cmd+clicking the buddy's name runs toggle-expanded.sh.
set -euo pipefail

app="$HOME/Applications/Coding Buddy Toggle.app"
toggle="${1:-$HOME/.claude-buddy/app/statusline/toggle-expanded.sh}"
plist="$app/Contents/Info.plist"
source_file=$(mktemp -t coding-buddy-toggle)

# The URL itself is ignored: any web page can open coding-buddy:// links.
cat > "$source_file" <<EOF
on open location theURL
	do shell script "/bin/bash " & quoted form of "$toggle"
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
echo "Registered coding-buddy:// -> $toggle"
