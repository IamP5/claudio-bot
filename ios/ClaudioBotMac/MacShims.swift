import AppKit
import SwiftUI

// The iPhone's navigation-bar and keyboard modifiers under the same names, so the shared views build unchanged.
// Each configures something a Mac window does not have, so each does nothing or maps to the Mac's own placement.

enum NavigationBarItem {
    enum TitleDisplayMode { case automatic, inline, large }
}

struct TextInputAutocapitalization: Sendable {
    static let never = Self(), words = Self(), sentences = Self(), characters = Self()
}

enum UIKeyboardType: Sendable { case `default`, URL, decimalPad, numberPad, asciiCapable }

extension View {
    func navigationBarTitleDisplayMode(_ mode: NavigationBarItem.TitleDisplayMode) -> some View { self }
    func textInputAutocapitalization(_ autocapitalization: TextInputAutocapitalization?) -> some View { self }
    func keyboardType(_ type: UIKeyboardType) -> some View { self }
    func listSectionSpacing(_ spacing: CGFloat) -> some View { self }
}

extension ToolbarItemPlacement {
    static var topBarLeading: ToolbarItemPlacement { .navigation }
    static var topBarTrailing: ToolbarItemPlacement { .primaryAction }
}

extension PickerStyle where Self == MenuPickerStyle {
    static var navigationLink: MenuPickerStyle { .menu }
}

extension NSColor {
    /// iOS's dark secondarySystemBackground, for the markdown code block.
    static var secondarySystemBackground: NSColor { NSColor(srgbRed: 28 / 255, green: 28 / 255, blue: 30 / 255, alpha: 1) }
}
