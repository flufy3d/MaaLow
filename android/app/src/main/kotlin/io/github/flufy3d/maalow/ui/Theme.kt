package io.github.flufy3d.maalow.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** The mascot's colors: ink fur, cream face, orange ears. Same palette as the web UI (assets/web/style.css). */
object Palette {
    val Ink = Color(0xFF28292D)
    val Cream = Color(0xFFFEF6EA)
    val Orange = Color(0xFFFE875A)
    val Green = Color(0xFF3FA66B)
    val Red = Color(0xFFD9534F)
}

private val Light = lightColorScheme(
    primary = Palette.Orange,
    onPrimary = Palette.Ink,
    primaryContainer = Color(0xFFFFE2D4),
    onPrimaryContainer = Color(0xFF5B2913),
    secondary = Palette.Ink,
    onSecondary = Palette.Cream,
    secondaryContainer = Color(0xFFEDE5D8),
    onSecondaryContainer = Palette.Ink,
    background = Color(0xFFF7F2EA),
    onBackground = Palette.Ink,
    surface = Color(0xFFFFFDF9),
    onSurface = Palette.Ink,
    surfaceVariant = Color(0xFFF1EADF),
    onSurfaceVariant = Color(0xFF6F685E),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFFFDF9),
    surfaceContainer = Color(0xFFFBF7F0),
    surfaceContainerHigh = Color(0xFFF5EFE5),
    surfaceContainerHighest = Color(0xFFF1EADF),
    outline = Color(0xFFCFC3B1),
    outlineVariant = Color(0xFFE6DCCD),
    error = Palette.Red,
    onError = Color.White,
)

private val Dark = darkColorScheme(
    primary = Palette.Orange,
    onPrimary = Palette.Ink,
    primaryContainer = Color(0xFF4B2A1C),
    onPrimaryContainer = Color(0xFFFFD9C7),
    secondary = Palette.Cream,
    onSecondary = Palette.Ink,
    secondaryContainer = Color(0xFF34353D),
    onSecondaryContainer = Palette.Cream,
    background = Color(0xFF1B1C20),
    onBackground = Color(0xFFF4EEE4),
    surface = Color(0xFF24252B),
    onSurface = Color(0xFFF4EEE4),
    surfaceVariant = Color(0xFF2D2E35),
    onSurfaceVariant = Color(0xFFA39D92),
    surfaceContainerLowest = Color(0xFF17181B),
    surfaceContainerLow = Color(0xFF24252B),
    surfaceContainer = Color(0xFF282930),
    surfaceContainerHigh = Color(0xFF2D2E35),
    surfaceContainerHighest = Color(0xFF34353D),
    outline = Color(0xFF4A4C55),
    outlineVariant = Color(0xFF383A42),
    error = Color(0xFFFF7B72),
    onError = Palette.Ink,
)

val Mono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp)

@Composable
fun MaaLowTheme(content: @Composable () -> Unit) {
    val base = Typography()
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) Dark else Light,
        typography = base.copy(
            headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.Black),
            titleMedium = base.titleMedium.copy(fontWeight = FontWeight.Bold),
        ),
        content = content,
    )
}
