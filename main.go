package main

import (
	"embed"
	"fmt"
	"io/fs"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var frontendAssets embed.FS

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--pair" {
		if err := storeIncomingPairing(os.Args[2]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "KOVA Voice Studio could not receive the Colab pairing link:", err)
		}
		// The already-open desktop app polls its private inbox and claims the
		// one-time code. Keeping this helper process headless avoids duplicate
		// windows when Chrome opens the custom kova-voice-studio:// link.
		return
	}
	frontendDist, err := fs.Sub(frontendAssets, "frontend/dist")
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "KOVA Voice Studio frontend assets are unavailable:", err)
		return
	}
	app := NewApp()
	if err := wails.Run(&options.App{
		Title:            "KOVA Voice Studio",
		Width:            1520,
		Height:           960,
		MinWidth:         1120,
		MinHeight:        720,
		DisableResize:    false,
		BackgroundColour: &options.RGBA{R: 12, G: 18, B: 37, A: 255},
		AssetServer:      &assetserver.Options{Assets: frontendDist},
		OnStartup:        app.Startup,
		Bind:             []interface{}{app},
	}); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "KOVA Voice Studio stopped:", err)
	}
}
