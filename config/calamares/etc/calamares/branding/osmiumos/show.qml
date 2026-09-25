import QtQuick 2.15
import calamares.slideshow 1.0

Presentation
{
    id: presentation

    function onActivate()
    {
        presentation.currentSlide = 0
    }

    function onLeave()
    {
    }

    Timer {
        id: advanceTimer
        interval: 7000
        running: presentation.activatedInCalamares
        repeat: true
        onTriggered: presentation.goToNextSlide()
    }

    Slide {
        centeredText: qsTr("Osmium OS")
    }

    Slide {
        centeredText: qsTr("Preparing your system")
    }

    Slide {
        centeredText: qsTr("Installing GNOME and Osmium OS")
    }

    Slide {
        centeredText: qsTr("Finishing setup")
    }
}
