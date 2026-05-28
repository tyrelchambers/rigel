APP_NAME := Helmsman
APP_BUNDLE := $(APP_NAME).app
BUNDLE_ID := com.tyrelchambers.helmsman

CONFIG ?= debug
BIN_DIR := $(shell swift build -c $(CONFIG) --show-bin-path)
BIN := $(BIN_DIR)/$(APP_NAME)

.PHONY: build app run release release-app release-run clean

build:
	swift build -c $(CONFIG)

# Assemble a minimal .app bundle around the SPM binary.
# Ad-hoc signs with our entitlements file so macOS honors the
# "not-sandboxed + no special data access needed" declaration. Required for
# UserNotifications (needs CFBundleIdentifier) and proper Dock behavior.
app: build
	@rm -rf $(APP_BUNDLE)
	@mkdir -p $(APP_BUNDLE)/Contents/MacOS
	@cp $(BIN) $(APP_BUNDLE)/Contents/MacOS/$(APP_NAME)
	@cp $(BIN_DIR)/$(APP_NAME)MCP $(APP_BUNDLE)/Contents/MacOS/$(APP_NAME)MCP
	@cp Resources/Info.plist $(APP_BUNDLE)/Contents/Info.plist
	@codesign --force --sign - --entitlements Resources/Helmsman.entitlements $(APP_BUNDLE) 2>&1 | sed 's/^/  /'
	@touch $(APP_BUNDLE)
	@echo "built $(APP_BUNDLE)"

run: app
	open $(APP_BUNDLE)

release:
	$(MAKE) build CONFIG=release

release-app:
	$(MAKE) app CONFIG=release

release-run: release-app
	open $(APP_BUNDLE)

clean:
	swift package clean
	rm -rf $(APP_BUNDLE)
