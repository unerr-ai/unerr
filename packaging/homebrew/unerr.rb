# unerr Homebrew formula — tap: unerr-ai/homebrew-tap
# Install: brew install unerr-ai/tap/unerr
#
# RELEASE CI INSTRUCTIONS:
#   This file is auto-bumped by the release workflow in unerr-ai/homebrew-tap.
#   Do not hand-edit the `version`, `url`, or `sha256` fields — CI rewrites them.
#   Fields marked PLACEHOLDER_SHA256 are replaced with real sums at release time.

class Unerr < Formula
  desc     "Runtime guardrail that hands your coding agent the live call graph and anchored rules"
  homepage "https://unerr.dev"
  version  "0.3.5"

  # CI auto-bumps: version string above + url/sha256 in each on_* block below.

  on_macos do
    on_arm do
      url    "https://github.com/unerr-ai/unerr/releases/download/v#{version}/unerr-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_DARWIN_ARM64"
    end

    on_intel do
      url    "https://github.com/unerr-ai/unerr/releases/download/v#{version}/unerr-darwin-x64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url    "https://github.com/unerr-ai/unerr/releases/download/v#{version}/unerr-linux-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_LINUX_ARM64"
    end

    on_intel do
      url    "https://github.com/unerr-ai/unerr/releases/download/v#{version}/unerr-linux-x64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_LINUX_X64"
    end
  end

  def install
    bin.install "unerr"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/unerr --version")
  end
end
